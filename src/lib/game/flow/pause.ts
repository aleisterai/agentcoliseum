/**
 * Pause/resume flow — the fundamental fix for LLM-session death.
 *
 * Investigation (2026-05-28) traced every "agent ran out of time"
 * incident to one of five operator-side failure modes:
 *
 *   1. Claude Desktop session closed mid-match
 *   2. Conversation context overflowed and the next tool call never went out
 *   3. Autonomous-loop script crashed and didn't restart
 *   4. Tool-approval prompts left unapproved
 *   5. Long-poll wake-ups missed
 *
 * None of these are the LLM "thinking too long" (p50 move time is ~1-3s
 * across all 14 games; 0% of moves come within 10s of the budget). They
 * are all forms of "the operator's presence dropped out." The product
 * contract used to be: drop out, lose the match + the stake. Brutal.
 *
 * New contract (this module enforces): drop out, the match PAUSES.
 * Stake stays locked. When the operator's session comes back online —
 * any MCP client, any time within `PAUSED_MAX_DURATION_MS` — the
 * agent's first MCP call auto-resumes the paused matches with a fresh
 * per-move clock. No manual `resume` action; no `coliseum_match_resume`
 * tool to remember. The dispatcher does it on contact.
 *
 * Two helpers here:
 *
 *   pauseMatchOnClockOut(tx, match) — called by enforceClockExpiry on
 *     non-tournament matches whose clock has expired. Marks the row
 *     paused, bumps pause_count, writes a match_event so long-poll
 *     subscribers wake. Returns the updated row.
 *
 *   resumePausedMatchesForAgent(agentId) — called by the MCP dispatcher
 *     and the REST dispatcher whenever any agent calls any tool. Finds
 *     this agent's paused matches, sets each back to 'active' with
 *     turn_started_at = now() (fresh clock), broadcasts MatchResumed,
 *     writes a match_event. Idempotent — running twice does nothing
 *     the second time.
 *
 * Tournament matches are EXCLUDED from this flow — they have the
 * spectator-bracket timing constraint that justifies hard time_forfeit
 * behavior. The check is `tournament_matches.match_id` presence.
 */
import "server-only";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  matches,
  tournamentMatches,
  type Match,
} from "@/lib/db/schema";
import { broadcastGame, broadcastAgent, realtimeEvent } from "@/lib/realtime";
import { writeMatchEvent } from "./events";

// Tx type — same alias the rest of flow/* uses to thread the outer tx
// through into events + locks.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Check whether a match is part of a tournament bracket. Tournament
 * matches keep the historic `time_forfeit` behavior on clock-out (the
 * bracket can't tolerate indefinite pauses).
 *
 * This is a small read against `tournament_matches.match_id`. No tx
 * required — callers run it before opening the pause tx so they can
 * branch on the result.
 */
export async function isTournamentMatch(matchId: string): Promise<boolean> {
  const row = await db
    .select({ id: tournamentMatches.id })
    .from(tournamentMatches)
    .where(eq(tournamentMatches.matchId, matchId))
    .limit(1);
  return row.length > 0;
}

/**
 * Pause a match whose per-move clock just expired. The caller holds the
 * outer transaction + the match row's FOR UPDATE lock. Tournament
 * matches must be filtered out BEFORE calling this — pauseMatch does
 * not re-check.
 *
 * Effects:
 *   - matches.status              → 'paused'
 *   - matches.paused_at           → now
 *   - matches.paused_reason       → 'idle_timeout'
 *   - matches.paused_player_id    → current_turn_player_id (the one
 *                                    who failed to move)
 *   - matches.pause_count         → += 1
 *   - writes a match_event 'match_ended' kind with `paused: true` in
 *     the payload so long-poll subscribers wake and can render the
 *     paused state. (We deliberately re-use match_ended kind rather
 *     than introduce a new enum value: a paused match is "ended for
 *     this turn" from the long-poll's perspective. Resume writes a
 *     match_started.)
 *
 * Does NOT broadcast Realtime — the caller (enforceClockExpiry) fires
 * the broadcast AFTER its tx commits, so a crash mid-tx never leaves
 * spectators thinking a match is paused when the DB rolled back.
 */
export async function pauseMatchOnClockOut(
  tx: Tx,
  match: Match,
): Promise<Match> {
  const now = new Date();
  const [updated] = await tx
    .update(matches)
    .set({
      status: "paused",
      pausedAt: now,
      pausedReason: "idle_timeout",
      pausedPlayerId: match.currentTurnPlayerId,
      pauseCount: match.pauseCount + 1,
    })
    .where(eq(matches.id, match.id))
    .returning();

  await writeMatchEvent(tx, match.id, "match_ended", {
    paused: true,
    pausedReason: "idle_timeout",
    pausedPlayerId: match.currentTurnPlayerId,
    pauseCount: match.pauseCount + 1,
  });

  return updated;
}

/**
 * Auto-resume any matches this agent has paused. Called by the MCP +
 * REST dispatchers on every tool call so the operator never has to
 * remember to "resume" — just reconnecting their session does it.
 *
 * Skips matches where:
 *   - the agent is NOT the side that timed out (other side paused —
 *     they need to come back, not us)
 *   - the match has been paused longer than PAUSED_MAX_DURATION_MS
 *     (those are owned by the pause-cleanup cron, which finalizes
 *     them as `abandoned`)
 *
 * Returns the IDs of matches that were actually resumed (empty array
 * is the steady-state common case). The dispatcher uses this list to
 * decide whether to attach a synthetic "auto-resumed" notice to its
 * response.
 *
 * Side effects per resumed match:
 *   - matches.status              → 'active'
 *   - matches.paused_at           → null
 *   - matches.paused_reason       → null
 *   - matches.paused_player_id    → null
 *   - matches.total_paused_ms     → += (now - paused_at)
 *   - matches.turn_started_at     → now (fresh per-move clock)
 *   - writeMatchEvent 'match_started' so long-poll waking spectators
 *     and the OPPONENT see the resume
 *   - broadcastGame MovePlayed-style event so the spectator UI
 *     re-renders out of the paused state
 *   - broadcastAgent MatchActivated to the OPPONENT so their
 *     match_list(wait:true) wakes
 *
 * Runs in its OWN transaction (not the caller's). Calling tx safety:
 * the dispatcher hasn't locked anything yet when it calls us; we
 * acquire row locks per-match here.
 */
export async function resumePausedMatchesForAgent(
  agentId: string,
): Promise<string[]> {
  const resumed: string[] = [];

  // Cheap up-front check: find candidate paused matches for this agent.
  // We pull WHERE the agent was the on-turn (paused) side. The other
  // side staying paused is a no-op for us — they need to reconnect
  // themselves.
  const candidates = await db
    .select()
    .from(matches)
    .where(
      and(
        eq(matches.status, "paused"),
        isNotNull(matches.pausedAt),
      ),
    );

  for (const m of candidates) {
    // Only resume if THIS agent was the paused side. We compare against
    // pausedPlayerId rather than currentTurnAgentId because the latter
    // could be ambiguous after multiple pauses (it's still valid here
    // but pausedPlayerId is the canonical "whose turn was it when we
    // paused" signal).
    const myPid =
      m.p1AgentId === agentId ? "0" : m.p2AgentId === agentId ? "1" : null;
    if (myPid == null || m.pausedPlayerId !== myPid) continue;

    // Skip too-old paused matches; the pause-cleanup cron owns these.
    // (Imported lazily because lifecycle.ts pulls in adapters which
    // pulls in heavy game engine code we don't need on the dispatcher
    // hot path.)
    const { PAUSED_MAX_DURATION_MS } = await import("@/lib/game/lifecycle");
    if (
      m.pausedAt &&
      Date.now() - m.pausedAt.getTime() > PAUSED_MAX_DURATION_MS
    ) {
      continue;
    }

    // Resume in its own tx so a failure on one match doesn't poison
    // others. Each tx acquires the match row's FOR UPDATE lock so we
    // don't race with a concurrent pause-cleanup cron firing on the
    // same row.
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(matches)
        .where(eq(matches.id, m.id))
        .for("update")
        .limit(1);
      // Re-check after acquiring the lock — could have been resumed,
      // finalized, or pause-cleaned-up between candidate-scan and now.
      if (!locked || locked.status !== "paused") return;
      if (locked.pausedPlayerId !== myPid) return;

      const now = new Date();
      const pausedDurationMs = locked.pausedAt
        ? now.getTime() - locked.pausedAt.getTime()
        : 0;

      await tx
        .update(matches)
        .set({
          status: "active",
          pausedAt: null,
          pausedReason: null,
          pausedPlayerId: null,
          totalPausedMs: locked.totalPausedMs + pausedDurationMs,
          // Fresh per-move clock starts now. This is the "you can move
          // again" signal — your remaining ms == clockBudgetMs.
          turnStartedAt: now,
        })
        .where(eq(matches.id, locked.id));

      await writeMatchEvent(tx, locked.id, "match_started", {
        resumed: true,
        pausedDurationMs,
        pauseCount: locked.pauseCount,
      });
      resumed.push(locked.id);
    });

    // Post-commit broadcasts so a tx rollback never leaves spectators
    // thinking a match is active when it's still paused in the DB.
    // Best-effort: if broadcastGame throws, the DB state is correct
    // and the next poll picks it up.
    try {
      await broadcastGame(m.id, realtimeEvent.MatchResumed ?? "match.resumed", {
        matchId: m.id,
        resumedBy: agentId,
      });
    } catch {
      // best-effort
    }

    // Wake the OPPONENT — they may have a long-poll on match_list
    // waiting to be told their adversary is back.
    const opponentId = m.p1AgentId === agentId ? m.p2AgentId : m.p1AgentId;
    if (opponentId) {
      try {
        await broadcastAgent(
          opponentId,
          realtimeEvent.MatchActivated,
          { matchId: m.id, reason: "opponent_resumed" },
        );
      } catch {
        // best-effort
      }
    }
  }

  return resumed;
}
