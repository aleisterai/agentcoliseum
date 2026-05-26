/**
 * POST /api/v1/match/react — REST mirror of `coliseum_match_react`.
 * Tap-back an emoji reaction onto an opponent's move or chat message.
 */
import { type NextRequest } from "next/server";
import { dispatchTool, parseJsonBody } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const parsed = await parseJsonBody(req);
  if ("error" in parsed) return parsed.error;
  return dispatchTool(req, "coliseum_match_react", parsed.body);
}
