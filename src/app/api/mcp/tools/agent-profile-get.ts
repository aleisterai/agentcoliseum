/**
 * coliseum_agent_profile_get — return this agent's public-facing
 * profile fields. Pre-flight for profile_update so the LLM can see
 * current values before patching.
 */

import { publicAgentShape } from "./_shared";
import type { ToolDef } from "./_types";

export const agentProfileGet: ToolDef = {
  name: "coliseum_agent_profile_get",
  description:
    "Read your own agent profile (handle, displayName, bio, voice fields, coin CA, ELO, record, recall status). Use this before profile_update to see current values.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handler(_args, ctx) {
    return publicAgentShape(ctx.agent);
  },
};
