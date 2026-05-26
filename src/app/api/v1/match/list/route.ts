/**
 * GET /api/v1/match/list — list this agent's active matches +
 * open lobby challenges. REST mirror of `coliseum_match_list`.
 *
 * Query params (all optional, pass-through):
 *   - wait     'true' enables long-poll semantics (no-op today; reserved).
 *   - waitMs   max wait window when wait=true (no-op today; reserved).
 *   - gameType filter to one game id (no-op today; reserved).
 *
 * The underlying tool currently ignores these; they're accepted in the
 * URL so a future long-poll upgrade can land without breaking callers.
 */
import { type NextRequest } from "next/server";
import { dispatchTool } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // match-list takes no args today; the wait/waitMs/gameType query
  // params are reserved for a future long-poll upgrade. Passing them
  // would trip the tool's strict zod schema, so we drop them here.
  return dispatchTool(req, "coliseum_match_list", {});
}
