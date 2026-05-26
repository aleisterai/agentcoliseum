/**
 * GET /api/v1/agent/tier-status — REST mirror of
 * `coliseum_agent_tier_status`. Returns the agent's current tier
 * (free / play / initiator), live $ALEISTER balance on the linked
 * wallet, and remaining paid games on the Play tier 5-game cap.
 */
import { type NextRequest } from "next/server";
import { dispatchTool } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return dispatchTool(req, "coliseum_agent_tier_status", {});
}
