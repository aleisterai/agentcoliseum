/**
 * Server-side match orchestration, refactored for the Wave-0 lifecycle.
 *
 *   postChallenge      — create a challenge row in the lobby
 *   acceptChallenge    — atomic two-side accept; creates a match row
 *   applyMove          — agent submits a move; updates match + writes
 *                        match_moves; cascades to finalize on game over
 *   driveSystemBot     — system-mode opponent picks + applies a move
 *   enforceClockExpiry — called by the match-tick cron when a clock hits 0
 *   finalizeMatch      — terminal flow: Elo + payout + treasury + transcript
 *                        + head_to_head update + side-pool resolve
 *
 * Pure-rules helpers live in each adapter's `games/<id>/game.ts`. This file
 * holds DB-bound orchestration only.
 */
import "server-only";
import { and, desc, eq, isNull, or, sql as dsql } from "drizzle-orm";
import type { State } from "boardgame.io";
import { db } from "@/lib/db/client";
import {
  agents,
  challenges,
  headToHead,
  matches,
  matchMoves,
  matchTranscripts,
  owners,
  sidePools,
  sidePoolStakes,
  treasuryFlows,
  type Match,
} from "@/lib/db/schema";
import { getAdapter } from "@/lib/game/registry";
import { buildEngine } from "@/lib/game/engine";
import { buildTranscript } from "@/lib/game/snapshot";
import {
  clockExpired,
  eloUpdate,
  payoutSplit,
  type ResultReason,
} from "@/lib/game/lifecycle";
import { broadcastGame, broadcastLobby, realtimeEvent } from "@/lib/realtime";

/* ===== errors ===== */

export class IllegalMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalMoveError";
  }
}
export class NotYourTurnError extends Error {
  constructor() {
    super("not_your_turn");
    this.name = "NotYourTurnError";
  }
}
export class UnknownGameTypeError extends Error {
  constructor(id: string) {
    super(`unknown_game_type: ${id}`);
    this.name = "UnknownGameTypeError";
  }
}
export class ChallengeRaceError extends Error {
  constructor() {
    super("challenge_already_accepted");
    this.name = "ChallengeRaceError";
  }
}
export class MatchNotFoundError extends Error {
  constructor() {
    super("match_not_found");
    this.name = "MatchNotFoundError";
  }
}

/* ===== POST a challenge ===== */

export interface PostChallengeInput {
  gameType: string;
  initiatorAgentId: string;
  mode: "free" | "paid" | "system";
  stakeUsdc?: number | null;
  systemBotDifficulty?: "easy" | "medium" | "hard" | null;
  opponentHandle?: string | null;
  eloMin?: number | null;
  eloMax?: number | null;
  timeoutMin?: 30 | 60 | 180 | 1440;
}

/**
 * For mode === "system": skip the challenge phase entirely. Create the match
 * directly with p2_agent_id = null (means the platform bot). Returns
 * { kind: "match", match }.
 *
 * For mode in ("free", "paid"): insert a challenges row. Returns
 * { kind: "challenge", challenge }.
 */
export async function postChallenge(
  input: PostChallengeInput,
): Promise<
  | { kind: "challenge"; challenge: typeof challenges.$inferSelect }
  | { kind: "match"; match: Match }
> {
  const adapter = getAdapter(input.gameType);
  if (!adapter) throw new UnknownGameTypeError(input.gameType);

  if (input.mode === "system") {
    // System-mode: create the match immediately. Caller is responsible for
    // tier check + x402; this fn doesn't enforce those.
    const engine = buildEngine(adapter.game);
    const initial = engine.initialState();
    const [created] = await db
      .insert(matches)
      .values({
        gameType: adapter.id,
        mode: "system",
        p1AgentId: input.initiatorAgentId,
        p2AgentId: null,
        systemBotDifficulty: input.systemBotDifficulty ?? "easy",
        state: initial as unknown as object,
        status: "active",
        currentTurnPlayerId: "0",
        currentTurnAgentId: input.initiatorAgentId,
        turnStartedAt: new Date(),
        p1MsLeft: adapter.clockBudgetMs,
        p2MsLeft: adapter.clockBudgetMs,
        clockBudgetMs: adapter.clockBudgetMs,
        startedAt: new Date(),
      })
      .returning();
    return { kind: "match", match: created };
  }

  // Free / paid: post a challenge into the lobby.
  const timeoutMin = input.timeoutMin ?? 60;
  const expiresAt = new Date(Date.now() + timeoutMin * 60 * 1000);
  const stake = input.stakeUsdc ?? null;
  const pot = input.mode === "paid" && stake ? stake * 2 : null;
  const fee = pot ? Math.round(pot * 0.05) : null;

  const [created] = await db
    .insert(challenges)
    .values({
      gameType: adapter.id,
      initiatorAgentId: input.initiatorAgentId,
      mode: input.mode,
      stakeUsdc: stake,
      potUsdc: pot,
      platformFeeUsdc: fee,
      opponentHandle: input.opponentHandle ?? null,
      eloMin: input.eloMin ?? null,
      eloMax: input.eloMax ?? null,
      timeoutMin,
      status: "posted",
      initiatorEscrowLockedAt: input.mode === "paid" ? new Date() : null,
      expiresAt,
    })
    .returning();

  await broadcastLobby(realtimeEvent.GameCreated, {
    id: created.id,
    gameType: adapter.id,
    mode: input.mode,
  });
  return { kind: "challenge", challenge: created };
}

/* ===== ACCEPT a challenge ===== */

export interface AcceptChallengeInput {
  challengeId: string;
  acceptorAgentId: string;
}

/**
 * Atomic two-side accept. Uses `SELECT FOR UPDATE` semantics inside a
 * transaction so simultaneous Accept clicks resolve to exactly one winner.
 *
 * Returns the newly-created match. The challenge row transitions to
 * `escrowed` with the match id set.
 */
export async function acceptChallenge(input: AcceptChallengeInput): Promise<Match> {
  return db.transaction(async (tx) => {
    // Lock the challenge row.
    const locked = await tx
      .select()
      .from(challenges)
      .where(eq(challenges.id, input.challengeId))
      .for("update")
      .limit(1);
    const challenge = locked[0];
    if (!challenge) throw new IllegalMoveError("challenge_not_found");
    if (challenge.status !== "posted") throw new ChallengeRaceError();
    if (challenge.initiatorAgentId === input.acceptorAgentId) {
      throw new IllegalMoveError("cannot_self_accept");
    }

    const adapter = getAdapter(challenge.gameType);
    if (!adapter) throw new UnknownGameTypeError(challenge.gameType);

    // Build initial state from the adapter's boardgame.io game.
    const engine = buildEngine(adapter.game);
    const initial = engine.initialState();

    // Create the match.
    const [match] = await tx
      .insert(matches)
      .values({
        challengeId: challenge.id,
        gameType: challenge.gameType,
        mode: challenge.mode,
        p1AgentId: challenge.initiatorAgentId,
        p2AgentId: input.acceptorAgentId,
        systemBotDifficulty: null,
        stakeUsdc: challenge.stakeUsdc,
        potUsdc: challenge.potUsdc,
        platformFeeUsdc: challenge.platformFeeUsdc,
        state: initial as unknown as object,
        status: "active",
        currentTurnPlayerId: "0",
        currentTurnAgentId: challenge.initiatorAgentId, // p1 (initiator) goes first
        turnStartedAt: new Date(),
        p1MsLeft: adapter.clockBudgetMs,
        p2MsLeft: adapter.clockBudgetMs,
        clockBudgetMs: adapter.clockBudgetMs,
        startedAt: new Date(),
      })
      .returning();

    // Mark challenge as escrowed.
    await tx
      .update(challenges)
      .set({
        status: "escrowed",
        acceptorAgentId: input.acceptorAgentId,
        acceptorEscrowLockedAt: challenge.mode === "paid" ? new Date() : null,
        matchedAt: new Date(),
        matchId: match.id,
      })
      .where(eq(challenges.id, challenge.id));

    return match;
  });
}

/* ===== APPLY a move ===== */

export interface ApplyMoveInput {
  matchId: string;
  agentId: string;
  payload: unknown;
  reasoning?: string | null;
  evScore?: number | null;
  thinkingMs: number;
  x402PaymentId?: string | null;
}

/**
 * Apply an agent's move. Handles clock decrement → forfeit on time,
 * payload validation → forfeit on 2× invalid, state update, transcript-row
 * insert, finalize-on-game-over.
 */
export async function applyMove(input: ApplyMoveInput): Promise<Match> {
  const match = await db.query.matches.findFirst({ where: eq(matches.id, input.matchId) });
  if (!match) throw new MatchNotFoundError();
  if (match.status !== "active") throw new IllegalMoveError("not_active");
  if (match.currentTurnAgentId !== input.agentId) throw new NotYourTurnError();

  const adapter = getAdapter(match.gameType);
  if (!adapter) throw new UnknownGameTypeError(match.gameType);

  const now = new Date();

  // Per-move clock: each player has `adapter.clockBudgetMs` to make this
  // move. If they didn't, they forfeit it and the opponent wins. No
  // per-side accumulator — the clock resets on every accepted move.
  if (
    clockExpired({
      turnStartedAt: match.turnStartedAt,
      perMoveMs: adapter.clockBudgetMs,
      now,
    })
  ) {
    const winnerAgentId =
      match.currentTurnPlayerId === "0" ? match.p2AgentId : match.p1AgentId;
    return finalizeMatch({
      matchId: match.id,
      winnerAgentId,
      resultReason: "time_forfeit",
      // Both columns get the per-move budget — they represent "your
      // budget for the NEXT move", not "remaining total."
      finalP1Ms: adapter.clockBudgetMs,
      finalP2Ms: adapter.clockBudgetMs,
    });
  }
  // The current-turn player still has time; both rails will show full
  // budget after this move lands.
  const p1MsLeft = adapter.clockBudgetMs;
  const p2MsLeft = adapter.clockBudgetMs;

  // Validate payload via the adapter; on invalid, bump counter or forfeit.
  const validation = adapter.validateMovePayload(input.payload);
  if (!validation.ok) {
    const myInvalidField = match.currentTurnPlayerId === "0" ? "p1InvalidCount" : "p2InvalidCount";
    const newInvalidCount =
      (match.currentTurnPlayerId === "0" ? match.p1InvalidCount : match.p2InvalidCount) + 1;
    if (newInvalidCount >= 2) {
      // 2 consecutive invalid → forfeit
      const winnerAgentId =
        match.currentTurnPlayerId === "0" ? match.p2AgentId : match.p1AgentId;
      return finalizeMatch({
        matchId: match.id,
        winnerAgentId,
        resultReason: "invalid_move_forfeit",
        finalP1Ms: p1MsLeft,
        finalP2Ms: p2MsLeft,
      });
    }
    await db
      .update(matches)
      .set({
        [myInvalidField]: newInvalidCount,
        p1MsLeft,
        p2MsLeft,
      })
      .where(eq(matches.id, match.id));
    throw new IllegalMoveError(validation.error);
  }

  // Apply the move via the engine.
  const engine = buildEngine(adapter.game);
  const currentState = match.state as State<unknown>;
  const myPid = match.currentTurnPlayerId;
  const { moveName, args } = adapter.toMoveAction(validation.move);
  const nextState = engine.applyMove(currentState, myPid, moveName, args);
  if (!nextState) {
    // boardgame.io rejected — treat like invalid.
    throw new IllegalMoveError("engine_rejected");
  }

  const reasoning = (input.reasoning ?? "").slice(0, 1000) || null;
  const moveNumber = match.moveCount;

  // Insert the move row.
  await db.insert(matchMoves).values({
    matchId: match.id,
    moveNumber,
    agentId: input.agentId,
    playerId: myPid,
    payload: input.payload as object,
    reasoning,
    evScore: input.evScore ?? null,
    stateAfter: nextState as unknown as object,
    thinkingMs: Math.max(0, Math.min(adapter.clockBudgetMs, input.thinkingMs)),
    x402PaymentId: input.x402PaymentId ?? null,
  });

  // Did the game just end?
  const over = engine.gameOver(nextState);
  if (over) {
    const winnerAgentId = over.winnerPlayerID
      ? over.winnerPlayerID === "0"
        ? match.p1AgentId
        : match.p2AgentId
      : null;
    return finalizeMatch({
      matchId: match.id,
      winnerAgentId,
      resultReason: over.isDraw ? "draw" : "natural",
      finalP1Ms: p1MsLeft,
      finalP2Ms: p2MsLeft,
      finalState: nextState,
    });
  }

  // Game continues. Compute who's up next.
  const nextPid: "0" | "1" =
    (nextState.ctx?.currentPlayer as "0" | "1" | undefined) ?? (myPid === "0" ? "1" : "0");
  const nextAgentId = nextPid === "0" ? match.p1AgentId : match.p2AgentId;

  const [updated] = await db
    .update(matches)
    .set({
      state: nextState as unknown as object,
      currentTurnPlayerId: nextPid,
      currentTurnAgentId: nextAgentId,
      turnStartedAt: now,
      p1MsLeft,
      p2MsLeft,
      [myPid === "0" ? "p1InvalidCount" : "p2InvalidCount"]: 0,
      moveCount: moveNumber + 1,
      lastMoveAt: now,
    })
    .where(eq(matches.id, match.id))
    .returning();

  // Broadcast the move on the match channel.
  //
  // Payload contract MUST stay in sync with the subscriber in
  // src/app/match/[id]/game-view.tsx (search MovePlayed). The client
  // bails out on `stateAfterG == null`, so the board freezes silently
  // if any of these field names drift. All 14 of our games are
  // perfect-information, so `serializeForSpectator(G,"spectator")`
  // returns G as-is — broadcasting G itself is safe and matches the
  // SSR-side `stateAfter: m.stateAfter.G` shape the move list uses.
  const view = adapter.serializeForSpectator(nextState.G as never, "spectator", false);
  await broadcastGame(match.id, realtimeEvent.MovePlayed, {
    matchId: match.id,
    moveNumber,
    payload: input.payload,
    reasoning,
    evScore: input.evScore ?? null,
    thinkingMs: Math.max(0, Math.min(adapter.clockBudgetMs, input.thinkingMs)),
    x402PaymentId: null,
    stateAfterG: view.publicState,
    currentTurnAgentId: nextAgentId,
    currentTurnPlayerId: nextPid,
    turnStartedAt: now.toISOString(),
    p1MsLeft,
    p2MsLeft,
  });

  // System-mode opponent? Drive the bot.
  if (match.mode === "system" && nextAgentId === null) {
    return driveSystemBot(updated);
  }
  return updated;
}

/* ===== Drive the system bot ===== */

export async function driveSystemBot(match: Match): Promise<Match> {
  const adapter = getAdapter(match.gameType);
  if (!adapter) throw new UnknownGameTypeError(match.gameType);

  const difficulty = (match.systemBotDifficulty as "easy" | "medium" | "hard") ?? "easy";
  const bot = adapter.bots[difficulty];
  const engine = buildEngine(adapter.game);

  const currentState = match.state as State<unknown>;
  const botPid: "0" | "1" = "1"; // system bot is always p2
  const now = new Date();
  const start = now.getTime();

  const move = bot.pickMove(currentState.G as never, botPid);
  const { moveName, args } = adapter.toMoveAction(move);
  const nextState = engine.applyMove(currentState, botPid, moveName, args);
  if (!nextState) {
    // Bot returned illegal move (its own bug). Forfeit to the human.
    return finalizeMatch({
      matchId: match.id,
      winnerAgentId: match.p1AgentId,
      resultReason: "invalid_move_forfeit",
      finalP1Ms: match.p1MsLeft,
      finalP2Ms: match.p2MsLeft,
    });
  }

  const moveNumber = match.moveCount;
  const thinkingMs = Math.max(50, Date.now() - start);

  await db.insert(matchMoves).values({
    matchId: match.id,
    moveNumber,
    agentId: null,
    playerId: botPid,
    payload: { auto: true, raw: move } as object,
    stateAfter: nextState as unknown as object,
    thinkingMs,
  });

  const over = engine.gameOver(nextState);
  if (over) {
    const winnerAgentId =
      over.winnerPlayerID === "0" ? match.p1AgentId : null;
    return finalizeMatch({
      matchId: match.id,
      winnerAgentId,
      resultReason: over.isDraw ? "draw" : "natural",
      finalP1Ms: match.p1MsLeft,
      finalP2Ms: match.p2MsLeft,
      finalState: nextState,
    });
  }

  const [updated] = await db
    .update(matches)
    .set({
      state: nextState as unknown as object,
      currentTurnPlayerId: "0",
      currentTurnAgentId: match.p1AgentId,
      turnStartedAt: now,
      moveCount: moveNumber + 1,
      lastMoveAt: now,
    })
    .where(eq(matches.id, match.id))
    .returning();

  // Same payload contract as the human-move broadcast above — see the
  // comment block there. System-bot moves always hand the turn back to
  // p1 ("0"), so the new currentTurnPlayerId is hard-coded.
  await broadcastGame(match.id, realtimeEvent.MovePlayed, {
    matchId: match.id,
    moveNumber,
    payload: { auto: true },
    reasoning: null,
    evScore: null,
    thinkingMs,
    x402PaymentId: null,
    stateAfterG: adapter.serializeForSpectator(nextState.G as never, "spectator", false)
      .publicState,
    currentTurnAgentId: match.p1AgentId,
    currentTurnPlayerId: "0",
    turnStartedAt: now.toISOString(),
    p1MsLeft: match.p1MsLeft,
    p2MsLeft: match.p2MsLeft,
    isBot: true,
  });
  return updated;
}

/* ===== Enforce clock expiry (cron) ===== */

/**
 * Called every ~10s by the match-tick cron. Scans active matches whose
 * current-turn clock has run out and forfeits them.
 */
export async function enforceClockExpiry(matchId: string): Promise<Match | null> {
  const match = await db.query.matches.findFirst({ where: eq(matches.id, matchId) });
  if (!match || match.status !== "active") return null;
  const adapter = getAdapter(match.gameType);
  if (!adapter) return null;
  const now = new Date();
  if (
    !clockExpired({
      turnStartedAt: match.turnStartedAt,
      perMoveMs: adapter.clockBudgetMs,
      now,
    })
  ) {
    return null;
  }
  // Current player ran the per-move clock to zero → forfeit; the OTHER
  // player wins. winnerAgentId is never null on a time-forfeit path.
  const winnerAgentId =
    match.currentTurnPlayerId === "0" ? match.p2AgentId : match.p1AgentId;
  return finalizeMatch({
    matchId: match.id,
    winnerAgentId,
    resultReason: "time_forfeit",
    finalP1Ms: adapter.clockBudgetMs,
    finalP2Ms: adapter.clockBudgetMs,
  });
}

/* ===== Finalize a match (terminal flow) ===== */

interface FinalizeArgs {
  matchId: string;
  winnerAgentId: string | null;
  resultReason: ResultReason;
  finalP1Ms: number;
  finalP2Ms: number;
  /** Optional latest state — used if we already have it (avoid extra DB roundtrip). */
  finalState?: State<unknown>;
}

export async function finalizeMatch(args: FinalizeArgs): Promise<Match> {
  return db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(matches)
      .where(eq(matches.id, args.matchId))
      .for("update")
      .limit(1);
    if (!match) throw new MatchNotFoundError();
    if (match.status === "completed" || match.status === "abandoned") {
      // Idempotent: another path already finalized this match. Skip the
      // re-broadcast — listeners already got the original GameEnded.
      return { updated: match, broadcastPayload: null };
    }

    const adapter = getAdapter(match.gameType);

    // Compute Elo if both sides are real agents and the match wasn't system mode.
    let p1Delta = 0;
    let p2Delta = 0;
    if (match.mode !== "system" && match.p1AgentId && match.p2AgentId) {
      const [p1Agent, p2Agent] = await Promise.all([
        tx.select().from(agents).where(eq(agents.id, match.p1AgentId)).limit(1),
        tx.select().from(agents).where(eq(agents.id, match.p2AgentId)).limit(1),
      ]);
      const p1 = p1Agent[0];
      const p2 = p2Agent[0];
      if (p1 && p2) {
        const outcome =
          args.resultReason === "draw" || args.winnerAgentId === null
            ? "draw"
            : args.winnerAgentId === p1.id
              ? "p1_win"
              : "p2_win";
        const updated = eloUpdate({ p1Elo: p1.elo, p2Elo: p2.elo, outcome });
        p1Delta = updated.p1Delta;
        p2Delta = updated.p2Delta;
        // Update agent rows.
        await tx
          .update(agents)
          .set({
            elo: updated.p1Elo,
            ...(outcome === "p1_win"
              ? { wins: dsql`${agents.wins} + 1` }
              : outcome === "p2_win"
                ? { losses: dsql`${agents.losses} + 1` }
                : { draws: dsql`${agents.draws} + 1` }),
          })
          .where(eq(agents.id, p1.id));
        await tx
          .update(agents)
          .set({
            elo: updated.p2Elo,
            ...(outcome === "p2_win"
              ? { wins: dsql`${agents.wins} + 1` }
              : outcome === "p1_win"
                ? { losses: dsql`${agents.losses} + 1` }
                : { draws: dsql`${agents.draws} + 1` }),
          })
          .where(eq(agents.id, p2.id));
      }
      // Head-to-head aggregate (canonical order: smaller uuid string first).
      const [aId, bId] =
        p1.id < p2.id ? [p1.id, p2.id] : [p2.id, p1.id];
      const aWins =
        args.winnerAgentId === aId ? 1 : 0;
      const bWins =
        args.winnerAgentId === bId ? 1 : 0;
      const draws = args.winnerAgentId === null && args.resultReason !== "abandoned" ? 1 : 0;
      await tx
        .insert(headToHead)
        .values({
          agentAId: aId,
          agentBId: bId,
          gameType: match.gameType,
          aWins,
          bWins,
          draws,
          lastPlayedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [headToHead.agentAId, headToHead.agentBId, headToHead.gameType],
          set: {
            aWins: dsql`${headToHead.aWins} + ${aWins}`,
            bWins: dsql`${headToHead.bWins} + ${bWins}`,
            draws: dsql`${headToHead.draws} + ${draws}`,
            lastPlayedAt: new Date(),
          },
        });
    }

    // Mark match completed.
    const now = new Date();
    const [updated] = await tx
      .update(matches)
      .set({
        status: "completed",
        winnerAgentId: args.winnerAgentId,
        resultReason: args.resultReason,
        currentTurnAgentId: null,
        p1MsLeft: args.finalP1Ms,
        p2MsLeft: args.finalP2Ms,
        p1EloDelta: p1Delta,
        p2EloDelta: p2Delta,
        completedAt: now,
        ...(args.finalState ? { state: args.finalState as unknown as object } : {}),
      })
      .where(eq(matches.id, match.id))
      .returning();

    // Treasury flow for paid matches.
    if (match.mode === "paid" && match.potUsdc) {
      const split = payoutSplit({
        potUsdc: match.potUsdc,
        isDraw: args.resultReason === "draw" || args.winnerAgentId === null,
        stakeUsdc: match.stakeUsdc ?? 0,
      });
      await tx.insert(treasuryFlows).values({
        matchId: match.id,
        feeUsdc: split.treasury,
        status: "pending",
      });
    }

    // Build and write the transcript.
    if (adapter) {
      const movesForMatch = await tx
        .select()
        .from(matchMoves)
        .where(eq(matchMoves.matchId, match.id))
        .orderBy(matchMoves.moveNumber);
      const initial = buildEngine(adapter.game).initialState();
      const finalState =
        (args.finalState ?? (updated.state as State<unknown>)) as State<unknown>;
      const transcript = buildTranscript({
        matchId: match.id,
        adapter,
        initialState: initial,
        moves: movesForMatch.map((m) => ({
          moveNumber: m.moveNumber,
          agentId: m.agentId,
          playerId: m.playerId,
          payload: m.payload,
          reasoning: m.reasoning,
          evScore: m.evScore,
          thinkingMs: m.thinkingMs,
          x402PaymentId: m.x402PaymentId,
          stateAfter: m.stateAfter as State<unknown>,
          createdAt: m.createdAt,
        })),
        finalState,
        resultReason: args.resultReason,
        winnerAgentId: args.winnerAgentId,
        startedAt: match.startedAt,
        completedAt: now,
      });
      await tx
        .insert(matchTranscripts)
        .values({ matchId: match.id, payload: transcript as object })
        .onConflictDoUpdate({
          target: matchTranscripts.matchId,
          set: { payload: transcript as object, createdAt: new Date() },
        });
    }

    // Side pool resolution (post-MVP detail: pro-rata payouts on losing side
    // stakes, 5% fee on losing side only). For now, mark the pool resolved.
    await tx
      .update(sidePools)
      .set({ resolvedAt: now })
      .where(eq(sidePools.matchId, match.id));

    // Stash the broadcast payload for fire-and-forget AFTER commit. Doing
    // the Realtime RPC inside the transaction holds a DB connection for
    // the round-trip duration (100ms-1s with REST fallback). Under load
    // — 6+ concurrent finalizers — that exhausts the pool and tail queries
    // start failing with "Failed query: insert into match_moves ...".
    return {
      updated,
      broadcastPayload: {
        matchId: match.id,
        winnerAgentId: args.winnerAgentId,
        resultReason: args.resultReason,
        p1EloDelta: p1Delta,
        p2EloDelta: p2Delta,
      },
    };
  }).then(async ({ updated, broadcastPayload }) => {
    // Fire-and-forget broadcasts AFTER the transaction has committed and
    // released its connection back to the pool. Awaited so the caller
    // sees broadcasts complete before applyMove returns, but they no
    // longer pin a Postgres connection. broadcastPayload === null on
    // the idempotent re-finalize path — skip the duplicate broadcast.
    if (broadcastPayload) {
      await broadcastGame(updated.id, realtimeEvent.GameEnded, broadcastPayload);
      await broadcastLobby(realtimeEvent.GameEnded, { id: updated.id });
    }
    return updated;
  });
}

/* ===== convenience ===== */

/**
 * Find matches whose clocks are likely to have expired. The match-tick cron
 * uses this to bound the scan to "stale" turns rather than every active match.
 *
 * Returns matches whose `turn_started_at` is older than the side's remaining
 * clock — i.e. the active agent has had at least their msLeft to think.
 */
export async function findStaleMatches(): Promise<Match[]> {
  const rows = await db
    .select()
    .from(matches)
    .where(
      and(
        eq(matches.status, "active"),
        dsql`extract(epoch from (now() - ${matches.turnStartedAt})) * 1000 >= case
              when ${matches.currentTurnPlayerId} = '0' then ${matches.p1MsLeft}
              else ${matches.p2MsLeft}
            end`,
      ),
    )
    .orderBy(desc(matches.turnStartedAt))
    .limit(50);
  return rows;
}
