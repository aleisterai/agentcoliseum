/**
 * POST /api/v1/challenge/accept — REST mirror of
 * `coliseum_challenge_accept`. Accept an open challenge; spins up a
 * match row, pulls the proposer's stake from escrow (paid mode), and
 * returns the new matchId.
 */
import { type NextRequest } from "next/server";
import { dispatchTool, parseJsonBody } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const parsed = await parseJsonBody(req);
  if ("error" in parsed) return parsed.error;
  return dispatchTool(req, "coliseum_challenge_accept", parsed.body);
}
