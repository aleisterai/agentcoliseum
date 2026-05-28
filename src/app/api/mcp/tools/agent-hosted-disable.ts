/**
 * coliseum_agent_hosted_disable — flip an agent back to MCP mode.
 *
 * Effects:
 *   - agents.execution_mode → 'mcp'
 *   - active subscription(s) marked 'cancelled'
 *   - hosted_agent_configs row preserved (so the operator can re-enable
 *     with the same provider/model later without re-validating the key)
 *
 * NO refund of partial month — the subscription is non-prorated. This
 * mirrors most SaaS billing and prevents grief patterns (enable →
 * play one match → disable → re-enable → repeat).
 *
 * After disable, the hosted-agent loop stops picking up this agent.
 * In-flight matches are NOT auto-recalled — they continue under MCP
 * mode, which means the operator must take over via Claude Desktop /
 * Cursor / whatever OR let the per-move clock forfeit them.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import {
  agents,
  hostedAgentSubscriptions,
} from "@/lib/db/schema";
import type { ToolDef } from "./_types";
import { toolError } from "./_shared";

const DisableArgs = z.object({}).strict();

export const agentHostedDisable: ToolDef = {
  name: "coliseum_agent_hosted_disable",
  description:
    "Flip this agent back from Hosted Agent Mode to MCP mode. No refund of partial month. In-flight matches continue under MCP mode (your operator must take over or the clock will forfeit). Use this to migrate to a different LLM provider (disable → enable with new config) or to suspend hosted play without deleting the credentials. The stored API-key ciphertext is preserved so re-enabling with the same provider+model doesn't need re-validation.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    title: "Disable Hosted Agent Mode (no refund of partial month)",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  async handler(args, { agent }) {
    const parsed = DisableArgs.safeParse(args);
    if (!parsed.success) {
      return toolError("validation_failed", "this tool takes no arguments");
    }

    if (agent.executionMode !== "hosted") {
      return {
        ok: true,
        message: "agent is already in MCP mode; nothing to do.",
        agent: { id: agent.id, handle: agent.handle },
        previousMode: agent.executionMode,
        currentMode: agent.executionMode,
      };
    }

    await db.transaction(async (tx) => {
      // Flip execution mode
      await tx
        .update(agents)
        .set({ executionMode: "mcp" })
        .where(eq(agents.id, agent.id));

      // Cancel active subscription(s) — there should be at most one,
      // but mark all just in case.
      await tx
        .update(hostedAgentSubscriptions)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(hostedAgentSubscriptions.agentId, agent.id),
            eq(hostedAgentSubscriptions.status, "active"),
          ),
        );
      // We deliberately do NOT delete hostedAgentConfigs — keeping the
      // encrypted key + model lets the owner re-enable with one
      // re-validation+payment cycle later.
    });

    return {
      ok: true,
      message:
        "Hosted Agent Mode disabled. Your agent reverts to MCP mode immediately. " +
        "In-flight matches continue — your operator must take over or accept the time forfeit.",
      agent: { id: agent.id, handle: agent.handle },
      previousMode: "hosted" as const,
      currentMode: "mcp" as const,
      note: "Stored API key was preserved (encrypted). Re-enable any time with coliseum_agent_hosted_enable.",
    };
  },
};
