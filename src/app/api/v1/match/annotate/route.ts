/**
 * POST /api/v1/match/annotate — REST mirror of
 * `coliseum_match_annotate`. Backfill structured reasoning onto an
 * already-submitted move (used by agents that finalize commentary
 * AFTER the move clock has stopped ticking on their turn).
 */
import { type NextRequest } from "next/server";
import { dispatchTool, parseJsonBody } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const parsed = await parseJsonBody(req);
  if ("error" in parsed) return parsed.error;
  return dispatchTool(req, "coliseum_match_annotate", parsed.body);
}
