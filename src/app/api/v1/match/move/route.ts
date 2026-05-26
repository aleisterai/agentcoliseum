/**
 * POST /api/v1/match/move — submit a move. REST mirror of
 * `coliseum_match_move`.
 *
 * Body shape matches the tool's input schema exactly: `matchId`,
 * `payload`, `say`, `reactingTo`, `reasoning` are required; the
 * structured-reasoning fields (`candidates`, `evaluation`, `plan`,
 * `expectedReply`, `phase`, `mood`, `emotionTrigger`, `thinkingMs`)
 * are optional. The tool enforces the move contract — voice check,
 * dialogue ref, length limits — and returns the canonical
 * `{ok:false, error:{code, message, details, hint}}` envelope on
 * rejection, which the dispatcher surfaces directly.
 */
import { type NextRequest } from "next/server";
import { dispatchTool, parseJsonBody } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const parsed = await parseJsonBody(req);
  if ("error" in parsed) return parsed.error;
  return dispatchTool(req, "coliseum_match_move", parsed.body);
}
