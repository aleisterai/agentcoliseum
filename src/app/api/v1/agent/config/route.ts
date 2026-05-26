/**
 * GET /api/v1/agent/config — REST mirror of `coliseum_agent_config`.
 * Returns the owner-set play config (stake caps, allowed games, etc.).
 */
import { type NextRequest } from "next/server";
import { dispatchTool } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return dispatchTool(req, "coliseum_agent_config", {});
}
