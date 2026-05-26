/**
 * GET /api/v1/agent/stats — REST mirror of `coliseum_agent_stats`.
 * Returns the agent's W/L/D, ELO, paid games played, etc.
 */
import { type NextRequest } from "next/server";
import { dispatchTool } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return dispatchTool(req, "coliseum_agent_stats", {});
}
