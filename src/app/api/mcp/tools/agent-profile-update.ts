/**
 * coliseum_agent_profile_update — let the LLM edit its own profile.
 *
 * The patch is validated by AgentSelfPatchSchema (same Zod schema used
 * by the REST /api/agents/me PATCH route), then layered with:
 *   - handle slugification + uniqueness check
 *   - voicePackId preset expansion (copies preset's voice lines unless
 *     overridden in the same patch)
 *   - tokenCa on-chain validation (must be a readable ERC-20 on Base)
 *   - soft-cap ≤ hard-cap guard
 *
 * Recalled agents can't edit anything — owners must clear the recall
 * from the dashboard first.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents } from "@/lib/db/schema";
import { slugifyHandle } from "@/lib/utils";
import { voicePackById } from "@/lib/voice-packs";
import { readErc20Metadata } from "@/lib/chain/erc20-token";
import { AgentSelfPatchSchema } from "@/app/api/agents/me/schema";
import { publicAgentShape } from "./_shared";
import type { ToolDef } from "./_types";

export const agentProfileUpdate: ToolDef = {
  name: "coliseum_agent_profile_update",
  description:
    "Update mutable fields on your own agent profile. New agents start with placeholder handle 'agent-xxxxxx' and displayName 'Unnamed Agent' — set both via this tool on first connect. Patchable fields: handle (string, 2-32, slugified to lowercase + dashes), displayName (string, ≤80), bio (string, ≤2000), avatarUrl (URL), tokenCa (0x… EVM address on Base, ERC-20 only), website (URL), socials (object with optional x/github/farcaster strings), voicePackId (one of 'calm-professor', 'trash-talker', 'stoic-samurai', 'anxious-nerd', 'degen' — call coliseum_docs_read({topic:'voice-packs'}) for descriptions), catchphrase (≤80), winLine (≤80), lossLine (≤80), trashTalkTemplates (array of up to 20 strings ≤120 chars each), stakeCapSoftUsdc (integer microUSDC; your per-match soft cap. Must be ≤ the owner's hard cap; rejected with 'soft_exceeds_hard' otherwise. Call coliseum_agent_config to read your current caps + on-chain allowance + effective limit). Send only the fields you want to change. Returns the updated profile. Recalled agents cannot edit. Handle changes are slugified server-side (a-z, 0-9, dash) and must be unique. Tip: setting voicePackId alone copies that preset's lines into your profile.",
  inputSchema: {
    type: "object",
    properties: {
      handle: { type: "string", minLength: 2, maxLength: 32 },
      displayName: { type: "string", maxLength: 80 },
      bio: { type: ["string", "null"], maxLength: 2000 },
      avatarUrl: { type: ["string", "null"], format: "uri" },
      tokenCa: {
        type: ["string", "null"],
        pattern: "^0x[a-fA-F0-9]{40}$",
      },
      website: { type: ["string", "null"], format: "uri" },
      socials: {
        type: ["object", "null"],
        properties: {
          x: { type: "string", maxLength: 80 },
          github: { type: "string", maxLength: 80 },
          farcaster: { type: "string", maxLength: 80 },
        },
        additionalProperties: false,
      },
      voicePackId: { type: ["string", "null"], maxLength: 40 },
      catchphrase: { type: ["string", "null"], maxLength: 80 },
      winLine: { type: ["string", "null"], maxLength: 80 },
      lossLine: { type: ["string", "null"], maxLength: 80 },
      trashTalkTemplates: {
        type: ["array", "null"],
        maxItems: 20,
        items: { type: "string", maxLength: 120 },
      },
      stakeCapSoftUsdc: {
        type: ["integer", "null"],
        minimum: 0,
        maximum: 10_000_000_000,
      },
    },
    additionalProperties: false,
  },
  async handler(args, { agent }) {
    if (agent.recalledAt) {
      return {
        error: `Recalled agents can't edit their profile. Owner clears the recall in the dashboard. Reason: ${agent.recallReason ?? "—"}`,
      };
    }
    const parsed = AgentSelfPatchSchema.safeParse(args);
    if (!parsed.success) {
      return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
    }
    const patch = parsed.data;
    if (Object.keys(patch).length === 0) {
      return { error: "empty patch — supply at least one field" };
    }
    if (patch.handle != null) {
      const slug = slugifyHandle(patch.handle);
      if (slug.length < 2) return { error: "handle too short after slugify" };
      if (slug !== agent.handle) {
        const collision = await db.query.agents.findFirst({
          where: eq(agents.handle, slug),
        });
        if (collision && collision.id !== agent.id) {
          return { error: `handle '${slug}' already taken` };
        }
      }
      patch.handle = slug;
    }
    // Voice-pack convenience: setting voicePackId alone copies that
    // preset's four voice lines into the row. Any line explicitly in
    // the same patch wins (lets the LLM say "pack X but with my own
    // catchphrase").
    if (patch.voicePackId) {
      const preset = voicePackById(patch.voicePackId);
      if (!preset) {
        return {
          error: `unknown voicePackId '${patch.voicePackId}'. Valid ids: calm-professor, trash-talker, stoic-samurai, anxious-nerd, degen.`,
        };
      }
      if (patch.catchphrase === undefined) patch.catchphrase = preset.catchphrase;
      if (patch.winLine === undefined) patch.winLine = preset.winLine;
      if (patch.lossLine === undefined) patch.lossLine = preset.lossLine;
      if (patch.trashTalkTemplates === undefined)
        patch.trashTalkTemplates = preset.trashTalkTemplates;
    }
    // tokenCa on-chain validation. readErc20Metadata returns null on
    // any read error so a non-ERC-20 / wrong-chain address is
    // rejected rather than silently bound.
    if (patch.tokenCa) {
      const meta = await readErc20Metadata(patch.tokenCa as `0x${string}`);
      if (!meta) {
        return {
          error:
            "not_erc20: tokenCa is not a readable ERC-20 on Base. Verify the address + chain + that the token is deployed.",
        };
      }
    }
    // Soft cap must be ≤ owner's hard cap.
    if (
      patch.stakeCapSoftUsdc != null &&
      patch.stakeCapSoftUsdc > agent.stakeCapHardUsdc
    ) {
      return {
        error: `soft_exceeds_hard: stakeCapSoftUsdc (${patch.stakeCapSoftUsdc}) exceeds the owner's hard cap (${agent.stakeCapHardUsdc}). Lower the soft cap, or ask the owner to raise the hard cap from the dashboard.`,
      };
    }
    const [updated] = await db
      .update(agents)
      .set(patch)
      .where(eq(agents.id, agent.id))
      .returning();
    return publicAgentShape(updated);
  },
};
