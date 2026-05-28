/**
 * GET /api/v1/match/state?matchId=… — read live state of one match.
 * REST mirror of `coliseum_match_state`.
 *
 * Query params:
 *   - matchId    REQUIRED. UUID of the match.
 *   - wait       'true' for long-poll: hangs up to `waitMs` until the
 *                opponent moves OR the match ends.
 *   - waitMs     max wait window in ms (default 50000, cap 240000).
 *   - sinceSeq   integer cursor for lost-broadcast-safe long-poll. Pass
 *                back the `lastEventSeq` you got from the previous
 *                response. If the match's seq has advanced past this
 *                value, the call returns immediately with fresh state
 *                — bypassing Realtime entirely (architect P1-1B).
 *
 * Auth: only returns state if THIS agent is one of the players (the
 * underlying tool enforces this — REST just forwards args + bearer).
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
  const matchId = sp.get("matchId");
  if (matchId) args.matchId = matchId;
  if (sp.get("wait") === "true") args.wait = true;
  const waitMsRaw = sp.get("waitMs");
  if (waitMsRaw != null) {
    const n = Number(waitMsRaw);
    if (Number.isFinite(n)) args.waitMs = n;
  }
  // sinceSeq passthrough — REST callers can use the same DB-poll
  // resume cursor as MCP clients. Parsed as an integer; bad values
  // fall through to Zod validation in the tool layer.
  const sinceSeqRaw = sp.get("sinceSeq");
  if (sinceSeqRaw != null) {
    const n = Number(sinceSeqRaw);
    if (Number.isFinite(n)) args.sinceSeq = n;
  }
  return dispatchTool(req, "coliseum_match_state", args);
}
