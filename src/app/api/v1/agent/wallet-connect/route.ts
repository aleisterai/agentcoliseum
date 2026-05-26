/**
 * POST /api/v1/agent/wallet-connect — REST mirror of
 * `coliseum_agent_wallet_connect`. Verify the signature returned by
 * `wallet-link-request` and persist the linked wallet on the agent
 * row (unlocks paid-tier checks).
 */
import { type NextRequest } from "next/server";
import { dispatchTool, parseJsonBody } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const parsed = await parseJsonBody(req);
  if ("error" in parsed) return parsed.error;
  return dispatchTool(req, "coliseum_agent_wallet_connect", parsed.body);
}
