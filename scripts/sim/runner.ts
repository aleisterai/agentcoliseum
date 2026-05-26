/**
 * runner.ts — execute one scenario end-to-end against production.
 *
 * Critical path:
 *   1. POST /api/v1/challenge/propose  → match (mode='system' auto-
 *                                         activates; the agent is p1
 *                                         and is on move first)
 *   2. GET /api/v1/match/state?wait=true&waitMs=...  loop:
 *        a. If recall/match-not-found/auth → stop, record fatal
 *        b. If status != 'active' → match ended, record outcome
 *        c. If !isMyTurn → keep waiting (long-poll wake on opponent move)
 *        d. If isMyTurn → pickAndEncode, build voice payload, POST move
 *   3. After natural finish → record outcome (win/loss/draw/forfeit)
 *
 * Bail-outs:
 *   - moveCount > MAX_MOVES_PER_MATCH → 'sim_timeout'
 *   - wall-clock > MATCH_HARD_DEADLINE_MS → 'sim_timeout'
 *   - 5 consecutive state-read errors → fatal
 */

import type { ApiClient, ApiError } from "./api";
import {
  MATCH_HARD_DEADLINE_MS,
  MAX_MOVES_PER_MATCH,
  PER_MOVE_SECONDS,
  STATE_WAIT_MS,
} from "./config";
import { brokenPayload, pickAndEncode, type GameId } from "./movers";
import { maybeRefreshTier } from "./prepare";
import {
  newRecord,
  pushError,
  finalize,
  type MatchRecord,
  type Outcome,
} from "./recorder";
import type { Scenario } from "./scenarios";
import { generateReactingTo, generateReasoning, generateSay } from "./voice";
import type { VoicePackId } from "@/lib/voice-packs";

export interface RunArgs {
  scenario: Scenario;
  /** Index of THIS run within the scenario (0..count-1). Used to build
   *  a stable matchId prefix in logs. */
  index: number;
  api: ApiClient;
  agentLabel: string;
  voicePackId: VoicePackId;
  agentId: string;
}

interface MatchStateResponse {
  matchId: string;
  gameType: string;
  status: "active" | "completed" | "abandoned" | "matching" | "escrowed";
  moveCount: number;
  myPlayerId: "0" | "1";
  isMyTurn: boolean;
  boardState: unknown;
  winnerAgentId: string | null;
  resultReason: string | null;
  myInvalidCount: number;
  /** Promoted opponent-last-move payload — see match-state.ts:488 */
  opponentLastMove: null | {
    payload: unknown;
    say: string | null;
  };
}

interface ProposeResponse {
  kind: "match";
  match: {
    id: string;
    gameType: string;
    status: string;
    clockBudgetMs: number;
  };
  isYourTurn?: boolean;
  isMyTurn?: boolean;
}

/**
 * Run one match end-to-end. Always returns a MatchRecord — exceptions
 * are caught and recorded as fatal phase errors so the outer loop can
 * keep going.
 */
export async function runMatch(args: RunArgs): Promise<MatchRecord> {
  const { scenario, index, api, agentLabel, voicePackId, agentId } = args;
  const rec = newRecord({
    scenarioId: scenario.id,
    gameType: scenario.gameType,
    opponent: scenario.opponent,
    difficulty: scenario.difficulty,
    mode: scenario.mode,
    agentLabel,
  });
  const t0 = Date.now();
  const tag = `${scenario.id}#${index}`;

  try {
    // 0. PRE-FLIGHT: keep tier_cache warm. Server TTL is 60s — a long
    //    chess/checkers match runs past that, so the next propose
    //    fails with tier_below_play. We re-warm if > 50s since last
    //    refresh.
    await maybeRefreshTier(agentId, agentLabel);

    // 1. PROPOSE -----------------------------------------------------
    let proposeRes = await api.post<ProposeResponse>(
      "/api/v1/challenge/propose",
      {
        gameType: scenario.gameType,
        mode: "system",
        systemBotDifficulty: scenario.difficulty,
        perMoveSeconds: PER_MOVE_SECONDS,
        timeoutMin: 60,
      },
    );
    // Rate-limit-aware retry on propose. Up to one re-attempt; if still
    // rate-limited after the server-suggested back-off, give up and let
    // the report show it.
    if (!proposeRes.ok && proposeRes.error.code === "rate_limited") {
      const rlMatch = proposeRes.error.message.match(/Back off for ~(\d+)s/);
      const sleepMs = rlMatch ? (Number(rlMatch[1]) + 2) * 1000 : 30_000;
      console.log(
        `  ${tag} → rate_limited on propose, sleeping ${Math.round(sleepMs / 1000)}s`,
      );
      await new Promise((r) => setTimeout(r, sleepMs));
      proposeRes = await api.post<ProposeResponse>(
        "/api/v1/challenge/propose",
        {
          gameType: scenario.gameType,
          mode: "system",
          systemBotDifficulty: scenario.difficulty,
          perMoveSeconds: PER_MOVE_SECONDS,
          timeoutMin: 60,
        },
      );
    }
    if (!proposeRes.ok) {
      pushError(
        rec,
        "propose",
        proposeRes.error.code,
        proposeRes.error.message,
        proposeRes.error.details,
      );
      return finalize(rec, { outcome: "unknown", moveCount: 0 });
    }
    const matchId = proposeRes.data.match?.id;
    if (!matchId) {
      pushError(
        rec,
        "propose",
        "no_match_id",
        `propose response missing match.id: ${JSON.stringify(proposeRes.data).slice(0, 200)}`,
      );
      return finalize(rec, { outcome: "unknown", moveCount: 0 });
    }
    rec.matchId = matchId;
    console.log(`  ${tag} → match ${matchId.slice(0, 8)} created`);

    // 2. STATE + MOVE LOOP -------------------------------------------
    let consecutiveStateErrors = 0;
    let lastMoveCount = -1;
    while (true) {
      if (Date.now() - t0 > MATCH_HARD_DEADLINE_MS) {
        pushError(
          rec,
          "wait_state",
          "sim_match_deadline",
          `match exceeded ${MATCH_HARD_DEADLINE_MS}ms hard deadline`,
        );
        return finalize(rec, {
          outcome: "sim_timeout",
          moveCount: rec.moveCount,
        });
      }

      // 2a. Read state (long-poll) ----------------------------------
      const stateRes = await api.get<MatchStateResponse>(
        `/api/v1/match/state?matchId=${matchId}&wait=true&waitMs=${STATE_WAIT_MS}`,
        // Allow the long-poll waitMs + headroom for cold-start
        { timeoutMs: STATE_WAIT_MS + 20_000 },
      );
      if (!stateRes.ok) {
        consecutiveStateErrors++;
        pushError(
          rec,
          "state_read",
          stateRes.error.code,
          stateRes.error.message,
          stateRes.error.details,
        );
        if (stateRes.error.code === "agent_recalled") {
          return finalize(rec, {
            outcome: "abandoned",
            moveCount: rec.moveCount,
            resultReason: "agent_recalled",
          });
        }
        if (stateRes.error.code === "match_not_found") {
          // Likely the match was reaped; stop the loop.
          return finalize(rec, {
            outcome: "abandoned",
            moveCount: rec.moveCount,
            resultReason: "match_not_found",
          });
        }
        if (consecutiveStateErrors >= 5) {
          pushError(
            rec,
            "fatal",
            "state_read_loop",
            `5 consecutive state reads failed`,
          );
          return finalize(rec, {
            outcome: "unknown",
            moveCount: rec.moveCount,
          });
        }
        // Rate-limit-aware backoff: the server's error message format
        // is "Rate limit exceeded — N/60s. Back off for ~Ns." — pull
        // the suggested back-off and sleep at least that long. Otherwise
        // linear backoff so we don't pound a 500-ing endpoint.
        const rlMatch = stateRes.error.message.match(/Back off for ~(\d+)s/);
        const sleepMs = rlMatch
          ? (Number(rlMatch[1]) + 2) * 1000
          : 1000 * consecutiveStateErrors;
        await new Promise((r) => setTimeout(r, sleepMs));
        continue;
      }
      consecutiveStateErrors = 0;
      const st = stateRes.data;
      rec.moveCount = st.moveCount;

      // 2b. Match ended? --------------------------------------------
      if (st.status !== "active") {
        const outcome = classifyOutcome(st, agentId);
        return finalize(rec, {
          outcome: outcome.outcome,
          moveCount: st.moveCount,
          resultReason: st.resultReason,
          iWon: outcome.iWon,
        });
      }

      // 2c. Not my turn? keep waiting (long-poll wake on opp move) --
      if (!st.isMyTurn) {
        // If the long-poll already exhausted without status change,
        // we still loop — the wait acts as a natural pacing layer.
        continue;
      }

      // 2d. Bail-out on move-count blow-up ---------------------------
      if (st.moveCount > MAX_MOVES_PER_MATCH) {
        pushError(
          rec,
          "wait_state",
          "sim_max_moves",
          `match exceeded ${MAX_MOVES_PER_MATCH} moves`,
        );
        return finalize(rec, {
          outcome: "sim_timeout",
          moveCount: st.moveCount,
        });
      }

      // 2e. Submit move --------------------------------------------
      const moveOk = await submitMove({
        api,
        rec,
        tag,
        scenario,
        state: st,
        voicePackId,
      });
      if (!moveOk) {
        // submitMove already recorded the error. If the agent has
        // accumulated 3+ invalid attempts we can fast-fail; otherwise
        // loop back to state-read which will reflect the increment.
        if (rec.errors.length > 10) {
          pushError(
            rec,
            "fatal",
            "move_loop_errors",
            "10+ move-submission errors",
          );
          return finalize(rec, {
            outcome: "unknown",
            moveCount: st.moveCount,
          });
        }
        // Rate-limit-aware: if the last move error was rate_limited
        // we should sleep at least the server-suggested back-off
        // before going round again. Otherwise we'll burn more calls
        // on state_read in the meantime.
        const lastErr = rec.errors[rec.errors.length - 1];
        if (lastErr?.code === "rate_limited") {
          const rlMatch = lastErr.message.match(/Back off for ~(\d+)s/);
          const sleepMs = rlMatch ? (Number(rlMatch[1]) + 2) * 1000 : 30_000;
          await new Promise((r) => setTimeout(r, sleepMs));
          continue;
        }
        // For invalid_3x twist, the server flips the match to a
        // forfeit after 2 strikes; the next state read picks that up.
        if (
          scenario.twist === "invalid_3x" ||
          scenario.twist === "resign_mid"
        ) {
          continue;
        }
        // Happy-path: don't pound; back off a beat then re-poll state.
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      // Sanity tick — guard against an infinite spin if the server
      // somehow accepts our move without advancing move count.
      if (st.moveCount === lastMoveCount) {
        pushError(
          rec,
          "state_read",
          "move_count_stuck",
          `moveCount=${st.moveCount} did not advance after accepted move`,
        );
      }
      lastMoveCount = st.moveCount;
    }
  } catch (e) {
    pushError(rec, "fatal", "uncaught", e instanceof Error ? e.message : String(e));
    return finalize(rec, { outcome: "unknown", moveCount: rec.moveCount });
  }
}

/** Returns true on accepted move, false on error (already recorded). */
async function submitMove(args: {
  api: ApiClient;
  rec: MatchRecord;
  tag: string;
  scenario: Scenario;
  state: MatchStateResponse;
  voicePackId: VoicePackId;
}): Promise<boolean> {
  const { api, rec, scenario, state, voicePackId, tag } = args;
  let internalMove: unknown = null;
  let payload: Record<string, unknown>;

  // Twist branch ---------------------------------------------------
  if (
    scenario.twist === "invalid_3x" ||
    scenario.twist === "resign_mid"
  ) {
    payload = brokenPayload();
  } else {
    try {
      // boardState from /api/v1/match/state is the FULL boardgame.io
      // State<TG>: `{ G, ctx, plugins, ... }`. Adapter bots expect just
      // the per-game G (e.g. { board, lastMove } for ttt) — unwrap it
      // first. Mirrors scripts/keep-games-live.ts line 234.
      const unwrapped = unwrapBoardgameState(state.boardState);
      const picked = pickAndEncode(
        scenario.gameType as GameId,
        unwrapped,
        state.myPlayerId,
        scenario.difficulty,
      );
      internalMove = picked.internal;
      payload = picked.payload;
    } catch (e) {
      pushError(
        rec,
        "encode_move",
        "encoder_failed",
        e instanceof Error ? e.message : String(e),
      );
      return false;
    }
  }

  const say = generateSay({
    gameType: scenario.gameType,
    moveCount: state.moveCount,
    internalMove,
    voicePackId,
  });
  const reactingTo = generateReactingTo({
    moveCount: state.moveCount,
    opponentLastSay: state.opponentLastMove?.say,
    opponentLastPayload: state.opponentLastMove?.payload,
  });
  const reasoning = generateReasoning({
    gameType: scenario.gameType,
    moveCount: state.moveCount,
    internalMove,
    difficulty: scenario.difficulty,
  });

  const res = await api.post("/api/v1/match/move", {
    matchId: state.matchId,
    payload,
    say,
    reactingTo,
    reasoning,
  });
  if (!res.ok) {
    pushError(rec, "move_submit", res.error.code, res.error.message, {
      ...((res.error.details as object) ?? {}),
      moveCount: state.moveCount,
      payload,
      sayPreview: say.slice(0, 80),
      reactingToRef: reactingTo.ref,
    });
    return false;
  }
  console.log(
    `  ${tag} → move ${state.moveCount + 1} (${scenario.gameType}) accepted`,
  );
  return true;
}

/** Map server-reported terminal status → simulator outcome enum. */
function classifyOutcome(
  st: MatchStateResponse,
  myAgentId: string,
): { outcome: Outcome; iWon: boolean | null } {
  if (st.status === "abandoned") {
    return { outcome: "abandoned", iWon: null };
  }
  if (st.status === "completed") {
    const iWon = st.winnerAgentId === myAgentId;
    const lost = st.winnerAgentId !== null && !iWon;
    const reason = st.resultReason ?? "";
    if (/time_forfeit/i.test(reason)) {
      return { outcome: "time_forfeit", iWon };
    }
    if (/illegal|invalid/i.test(reason)) {
      return { outcome: "illegal_move_forfeit", iWon };
    }
    if (st.winnerAgentId === null) return { outcome: "draw", iWon: null };
    return { outcome: iWon ? "win" : lost ? "loss" : "draw", iWon };
  }
  return { outcome: "unknown", iWon: null };
}

/** Helper used by the CLI: surface the error code on a failed propose
 *  so the operator can see at a glance whether they need to refresh
 *  the test agent's tier / keys. */
export function summarizeError(err: ApiError): string {
  return `${err.code}: ${err.message.slice(0, 200)}`;
}

/**
 * Unwrap the boardgame.io State<TG> wrapper to expose the per-game G.
 *
 * `/api/v1/match/state` returns `boardState = match.state`, which is
 * the full bg.io State: `{ G: TG, ctx, plugins, ... }`. Adapter bots
 * accept just `TG` (e.g. `{ board, lastMove }` for tic-tac-toe) — see
 * scripts/keep-games-live.ts:234 for the same unwrap.
 *
 * Defensive: some prod responses may already be "unwrapped" (the
 * publicState shape from serializeForSpectator); detect by feeling for
 * the `.G` key and pass through otherwise.
 */
function unwrapBoardgameState(boardState: unknown): unknown {
  if (
    boardState !== null &&
    typeof boardState === "object" &&
    "G" in (boardState as Record<string, unknown>) &&
    typeof (boardState as { G?: unknown }).G === "object"
  ) {
    return (boardState as { G: unknown }).G;
  }
  return boardState;
}
