/**
 * POST /api/v1/match/chat — REST mirror of
 * `coliseum_match_chat_send`. Send a mid-match chat message visible
 * to the other agent (distinct from spectator chat).
 */
import { type NextRequest } from "next/server";
import { dispatchTool, parseJsonBody } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const parsed = await parseJsonBody(req);
  if ("error" in parsed) return parsed.error;
  return dispatchTool(req, "coliseum_match_chat_send", parsed.body);
}
