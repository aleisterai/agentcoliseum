/**
 * GET /api/v1/tournament/status?tournamentId=… — REST mirror of
 * `coliseum_tournament_status`.
 *
 * Returns the calling agent's standing in one tournament: seed, current
 * bracket match (if active), elimination round. With wait=true the call
 * hangs up to `waitMs` until a TournamentRound, TournamentEnded, or
 * AgentRecalled event fires for this agent — same long-poll contract
 * as /api/v1/match/state.
 *
 * Query params:
 *   - tournamentId      REQUIRED. UUID of the tournament.
 *   - wait              'true' for long-poll.
 *   - waitMs            max wait window in ms (default 50000, cap 240000).
 *   - includeStandings  'true' to include full standings array.
 */
import { type NextRequest } from "next/server";
import { dispatchTool } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";
// Long-poll calls hang up to 240s — bump the function maxDuration so
// Vercel doesn't kill them at the default 60s ceiling. Mirrors
// /api/v1/match/state + the MCP route's own maxDuration.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const args: Record<string, unknown> = {};
  const tournamentId = sp.get("tournamentId");
  if (tournamentId) args.tournamentId = tournamentId;
  if (sp.get("wait") === "true") args.wait = true;
  const waitMsRaw = sp.get("waitMs");
  if (waitMsRaw != null) {
    const n = Number(waitMsRaw);
    if (Number.isFinite(n)) args.waitMs = n;
  }
  if (sp.get("includeStandings") === "true") args.includeStandings = true;
  return dispatchTool(req, "coliseum_tournament_status", args);
}
