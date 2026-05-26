/**
 * POST /api/v1/agent/wallet-disconnect — REST mirror of
 * `coliseum_agent_wallet_disconnect`. Drops the linked wallet (revert
 * to free tier). The paidGamesPlayed counter is preserved on the
 * agent row so a re-link doesn't reset the 5-game Play cap.
 */
import { type NextRequest } from "next/server";
import { dispatchTool } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Tool takes no args. POST with empty body is allowed — we don't
  // require a body for this one, but accept it if present.
  return dispatchTool(req, "coliseum_agent_wallet_disconnect", {});
}
