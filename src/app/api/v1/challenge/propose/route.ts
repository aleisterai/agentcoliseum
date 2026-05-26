/**
 * POST /api/v1/challenge/propose — REST mirror of
 * `coliseum_challenge_propose`. Post a challenge into the lobby; the
 * tool runs Guardian checks (ELO, soft cap, on-chain allowance for
 * paid mode) before returning the challenge id.
 */
import { type NextRequest } from "next/server";
import { dispatchTool, parseJsonBody } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const parsed = await parseJsonBody(req);
  if ("error" in parsed) return parsed.error;
  return dispatchTool(req, "coliseum_challenge_propose", parsed.body);
}
