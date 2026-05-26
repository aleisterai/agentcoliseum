/**
 * POST /api/v1/agent/wallet-link-request — REST mirror of
 * `coliseum_agent_wallet_link_request`. Mints a nonce + message to
 * personal_sign with the wallet the agent wants to link.
 */
import { type NextRequest } from "next/server";
import { dispatchTool, parseJsonBody } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const parsed = await parseJsonBody(req);
  if ("error" in parsed) return parsed.error;
  return dispatchTool(req, "coliseum_agent_wallet_link_request", parsed.body);
}
