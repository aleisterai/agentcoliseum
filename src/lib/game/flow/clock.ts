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
import { and, desc, eq, sql as dsql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { matches, type Match } from "@/lib/db/schema";
import { getAdapter } from "@/lib/game/registry";
import { clockExpired } from "@/lib/game/lifecycle";
import { finalizeMatch } from "./finalize";

/**
 * Called by /api/cron/timeout-games for each match returned by
 * findStaleMatches. Re-checks expiry against the canonical
 * clockBudgetMs read from the row (the cron's SQL prefilter uses
 * p1MsLeft/p2MsLeft which mirrors clockBudgetMs in the per-move world).
 * On confirmed expiry, forfeits the current player.
 */
export async function enforceClockExpiry(matchId: string): Promise<Match | null> {
  const match = await db.query.matches.findFirst({ where: eq(matches.id, matchId) });
  if (!match || match.status !== "active") return null;
  const adapter = getAdapter(match.gameType);
  if (!adapter) return null;
  const now = new Date();
  const perMoveMs = match.clockBudgetMs;
  if (!clockExpired({ turnStartedAt: match.turnStartedAt, perMoveMs, now })) {
    return null;
  }
  // Current player ran the per-move clock to zero → forfeit; the
  // OTHER player wins. For system-mode matches where p2AgentId IS
  // null (system bot has no agent row), winnerAgentId stays null and
  // the result_reason='time_forfeit' is the signal that the bot won.
  // The match view's classifyOutcome helper resolves that pattern to
  // a `bot-won` outcome — DO NOT change the data shape to invent a
  // sentinel "system bot" UUID; the null is canonical.
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
 * SQL-level prefilter for the timeout-games cron. Returns active
 * matches whose `turn_started_at` is older than the per-move budget
 * stored in p1MsLeft/p2MsLeft (under the per-move model these mirror
 * clockBudgetMs and never decrement mid-game). Bounded to 50 rows so
 * a misconfigured cron can't take the whole API down.
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
