/**
 * Per-move clock orchestration: enforce expiry on a single match,
 * and find the set of stale matches the cron should sweep.
 *
 * Why this lives alongside applyMove (which has its own inline expiry
 * check): the cron path comes in cold (no API call, no agent submitting
 * a move). It needs to identify expired clocks via raw SQL, then forfeit
 * via the same finalize flow. Keeping it in its own file makes the cron
 * dependency explicit and avoids importing the whole match-flow surface.
 */
import "server-only";
import { and, asc, eq, isNull, sql as dsql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { matches, type Match } from "@/lib/db/schema";
import { getAdapter } from "@/lib/game/registry";
import {
  clockExpired,
  FIRST_MOVE_TIMEOUT_MS,
  PAUSE_COUNT_MAX,
} from "@/lib/game/lifecycle";
import { finalizeMatch } from "./finalize";
import { broadcastGame, broadcastAgent, realtimeEvent } from "@/lib/realtime";
import { isTournamentMatch, pauseMatchOnClockOut } from "./pause";

/**
 * Called by /api/cron/timeout-games for each match returned by
 * findStaleMatches. Re-checks expiry against the canonical
 * clockBudgetMs read from the row, then routes to one of three
 * outcomes depending on context:
 *
 *   - moveCount === 0 → `abandoned` (no game to win; both sides
 *     refunded; no ELO change). Move-0 fairness gate, untouched.
 *
 *   - Tournament match → `time_forfeit` (bracket timing constraint).
 *
 *   - pauseCount has hit `PAUSE_COUNT_MAX` already → `time_forfeit`
 *     by the OPPONENT. This is the anti-grief floor: an agent can't
 *     keep timing out + auto-resuming forever on the same match.
 *
 *   - Otherwise (regular non-tournament, real-play, under the pause
 *     limit) → PAUSE. Match holds its position; stake stays locked;
 *     the agent's owner reconnects (any MCP client, any time within
 *     PAUSED_MAX_DURATION_MS) and any MCP call auto-resumes the
 *     match. This is the fundamental fix for LLM-session death — see
 *     `flow/pause.ts` for the architecture comment.
 */
export async function enforceClockExpiry(matchId: string): Promise<Match | null> {
  const match = await db.query.matches.findFirst({ where: eq(matches.id, matchId) });
  if (!match || match.status !== "active") return null;
  const adapter = getAdapter(match.gameType);
  if (!adapter) return null;
  const now = new Date();
  const perMoveMs = match.clockBudgetMs;
  // Pass moveCount + agentReadyAt so the gate skips matches whose
  // on-turn agent hasn't yet acknowledged readiness via match_state.
  // Those are reaped by `refund-unready-matches` after 30 min.
  if (
    !clockExpired({
      turnStartedAt: match.turnStartedAt,
      perMoveMs,
      now,
      moveCount: match.moveCount,
      agentReadyAt: match.agentReadyAt,
    })
  ) {
    return null;
  }
  // FAIRNESS GATE — distinguish "nothing happened on the board" from
  // "real game stalled". When moveCount === 0, neither side has made
  // a single move; the on-turn agent's clock ran out before play
  // started. Calling that a "time_forfeit + opponent wins" is wrong
  // because the opponent never invested a move either — there's no
  // game to win or lose. Treat it as `abandoned`: refund both sides,
  // no ELO change. finalizeMatch already handles this branch like
  // a draw on the payout side. Move 1+ continues to the
  // pause-or-forfeit branch so the chess-clock discipline (or the
  // pause-on-timeout substitute) applies once real play is underway.
  if (match.moveCount === 0) {
    return finalizeMatch({
      matchId: match.id,
      winnerAgentId: null,
      resultReason: "abandoned",
      finalP1Ms: perMoveMs,
      finalP2Ms: perMoveMs,
    });
  }

  // Tournament-match branch: bracket timing constraints mean we
  // can't tolerate indefinite pauses. Keep historic time_forfeit
  // behavior.
  const isTournament = await isTournamentMatch(match.id);
  if (isTournament) {
    return finalizeForfeitNow(match, perMoveMs);
  }

  // Anti-grief: this side has already hit the pause cap. Convert this
  // expiry directly to a forfeit so a stalling operator can't keep
  // looping (close session → auto-pause → reopen → another move
  // window → close again, indefinitely).
  if (match.pauseCount >= PAUSE_COUNT_MAX) {
    return finalizeForfeitNow(match, perMoveMs);
  }

  // The fundamental fix: pause instead of forfeit. Stake stays locked;
  // match holds position. When the agent's owner reconnects any MCP
  // client and the agent calls any tool, the dispatcher auto-resumes.
  const paused = await db.transaction(async (tx) => {
    // Re-acquire under FOR UPDATE in case another writer touched the row.
    const [locked] = await tx
      .select()
      .from(matches)
      .where(eq(matches.id, match.id))
      .for("update")
      .limit(1);
    if (!locked || locked.status !== "active") return null;
    return pauseMatchOnClockOut(tx, locked);
  });

  // Post-tx broadcasts. Best-effort — DB state is authoritative.
  if (paused) {
    const broadcastPayload = {
      matchId: paused.id,
      pausedPlayerId: paused.pausedPlayerId,
      pauseCount: paused.pauseCount,
      pausedAt: paused.pausedAt?.toISOString() ?? null,
    };
    try {
      await broadcastGame(paused.id, realtimeEvent.MatchPaused, broadcastPayload);
    } catch {
      // best-effort
    }
    // Notify the paused agent's owner via the agent channel so any
    // long-poll they have running wakes immediately. This is layer 1
    // of the recovery flow: even if the owner missed the broadcast
    // in real time, the next MCP contact auto-resumes via the
    // dispatcher.
    const pausedAgentId =
      paused.pausedPlayerId === "0" ? paused.p1AgentId : paused.p2AgentId;
    if (pausedAgentId) {
      try {
        await broadcastAgent(pausedAgentId, realtimeEvent.MatchPaused, broadcastPayload);
      } catch {
        // best-effort
      }
    }
  }
  return paused;
}

/**
 * Helper: finalize as time_forfeit. Used by the tournament-match
 * branch AND by the pause-cap exceeded branch. Kept inline (vs in
 * finalize.ts) because the only callers are clock-expiry paths.
 */
function finalizeForfeitNow(match: Match, perMoveMs: number) {
  // System-mode matches where p2AgentId IS NULL: winnerAgentId stays
  // null and the result_reason='time_forfeit' is the signal that the
  // bot won. The match view's classifyOutcome helper resolves that
  // pattern to a `bot-won` outcome.
  const winnerAgentId =
    match.currentTurnPlayerId === "0" ? match.p2AgentId : match.p1AgentId;
  return finalizeMatch({
    matchId: match.id,
    winnerAgentId,
    resultReason: "time_forfeit",
    finalP1Ms: perMoveMs,
    finalP2Ms: perMoveMs,
  });
}

/**
 * SQL-level prefilter for the match-tick cron. Returns active matches
 * that have actually crossed some clock threshold. Two cases:
 *
 *   (1) Real per-move expiry — `move_count >= 1` (real play underway)
 *       AND `turn_started_at + clock_budget_ms <= now()`. This is the
 *       chess-clock discipline: the on-turn agent ran out of time.
 *
 *   (2) First-move stall — `move_count = 0 AND agent_ready_at IS NOT
 *       NULL AND agent_ready_at + FIRST_MOVE_TIMEOUT_MS <= now()`. The
 *       agent went ready but never played; tighter timeout than the
 *       full per-move budget (architect P0-#136). This used to fall
 *       under the regular per-move check, which meant up to 10 min of
 *       "live but stuck" time for long-clock games like chess.
 *
 * Matches with `move_count = 0 AND agent_ready_at IS NULL` are NOT
 * returned here — those are pre-ready "frozen" matches, swept by
 * `refund-unready-matches` after 30 min instead. Excluding them at
 * the SQL level fixes the under-forfeit bug (architect P1-#135):
 * before this fix they'd return inside the 50-row batch and crowd
 * out the actual expirations that needed action.
 *
 * Order: `turn_started_at ASC` (oldest first) so the most-overdue
 * matches get attention before newer expirations. Combined with the
 * exclusion above, this means a 50-row batch is now ~100% actionable
 * — every row will either forfeit or abandon in `enforceClockExpiry`.
 *
 * Bounded to 50 rows so a misconfigured cron can't take the whole
 * API down.
 */
export async function findStaleMatches(): Promise<Match[]> {
  const rows = await db
    .select()
    .from(matches)
    .where(
      and(
        eq(matches.status, "active"),
        dsql`(
          -- Case 1: per-move expiry on moves 1+ (real play).
          (${matches.moveCount} >= 1 AND extract(epoch from (now() - ${matches.turnStartedAt})) * 1000 >= ${matches.clockBudgetMs})
          OR
          -- Case 2: first-move stall (agent went ready but never moved).
          (${matches.moveCount} = 0 AND ${matches.agentReadyAt} IS NOT NULL AND extract(epoch from (now() - ${matches.turnStartedAt})) * 1000 >= ${FIRST_MOVE_TIMEOUT_MS})
        )`,
      ),
    )
    .orderBy(asc(matches.turnStartedAt))
    .limit(50);
  return rows;
}
