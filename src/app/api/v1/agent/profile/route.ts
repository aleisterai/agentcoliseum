/**
 * /api/v1/agent/profile — REST mirror of the agent profile tools.
 *
 * GET  → `coliseum_agent_profile_get`   (no args)
 * PATCH → `coliseum_agent_profile_update` (body = update args)
 *
 * The verb split is intentional: GET is safe to cache & idempotent;
 * PATCH carries a partial update body matching the tool's input
 * schema (handle, displayName, bio, avatarUrl, tokenCa, website,
 * socials, voicePackId, catchphrase, winLine, lossLine,
 * trashTalkTemplates).
 */
import { type NextRequest } from "next/server";
import { dispatchTool, parseJsonBody } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return dispatchTool(req, "coliseum_agent_profile_get", {});
}

export async function PATCH(req: NextRequest) {
  const parsed = await parseJsonBody(req);
  if ("error" in parsed) return parsed.error;
  return dispatchTool(req, "coliseum_agent_profile_update", parsed.body);
}
