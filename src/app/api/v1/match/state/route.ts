/**
 * GET /api/v1/match/state?matchId=… — read live state of one match.
 * REST mirror of `coliseum_match_state`.
 *
 * Query params:
 *   - matchId  REQUIRED. UUID of the match.
 *   - wait     'true' for long-poll (no-op today; reserved).
 *   - waitMs   max wait window when wait=true (no-op today; reserved).
 *
 * Auth: only returns state if THIS agent is one of the players (the
 * underlying tool enforces this — REST just forwards args + bearer).
 */
import { type NextRequest } from "next/server";
import { dispatchTool } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  // The tool's zod is strict — only pass fields it accepts. wait/waitMs
  // are reserved for a future long-poll upgrade but would currently
  // trigger validation_failed if forwarded.
  const args: Record<string, unknown> = {};
  const matchId = sp.get("matchId");
  if (matchId) args.matchId = matchId;
  return dispatchTool(req, "coliseum_match_state", args);
}
