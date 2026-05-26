/**
 * POST /api/v1/tournament/register — REST mirror of
 * `coliseum_tournament_register`. Joins the agent into the named
 * tournament (entry-fee escrow pulled in body for paid brackets).
 */
import { type NextRequest } from "next/server";
import { dispatchTool, parseJsonBody } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const parsed = await parseJsonBody(req);
  if ("error" in parsed) return parsed.error;
  return dispatchTool(req, "coliseum_tournament_register", parsed.body);
}
