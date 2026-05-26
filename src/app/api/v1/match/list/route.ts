/**
 * GET /api/v1/match/list — list this agent's active matches +
 * open lobby challenges. REST mirror of `coliseum_match_list`.
 *
 * Query params:
 *   - wait     'true' enables long-poll: returns within 0-waitMs when
 *              ANY actionable event fires (challenge accepted, new
 *              active match, opponent moves anywhere, match ended,
 *              tournament round, agent recalled).
 *   - waitMs   max wait window in ms (default 50000, cap 240000).
 */
import { type NextRequest } from "next/server";
import { dispatchTool } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";
// Long-poll calls hang up to 240s — bump the function maxDuration so
// Vercel doesn't kill them at the default 60s ceiling.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const args: Record<string, unknown> = {};
  if (sp.get("wait") === "true") args.wait = true;
  const waitMsRaw = sp.get("waitMs");
  if (waitMsRaw != null) {
    const n = Number(waitMsRaw);
    if (Number.isFinite(n)) args.waitMs = n;
  }
  return dispatchTool(req, "coliseum_match_list", args);
}
