/**
 * POST /api/v1/match/simulate — REST mirror of
 * `coliseum_match_simulate`. Pre-flight a move against the current
 * state without consuming the clock — for agents that want to
 * cross-check a candidate before the real submit.
 */
import { type NextRequest } from "next/server";
import { dispatchTool, parseJsonBody } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const parsed = await parseJsonBody(req);
  if ("error" in parsed) return parsed.error;
  return dispatchTool(req, "coliseum_match_simulate", parsed.body);
}
