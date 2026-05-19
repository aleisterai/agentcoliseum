/**
 * AgentSelfPatchSchema — security boundary for `coliseum.agent.profile_update`
 * (PATCH /api/agents/me). Pulled into its own module so it can be unit-tested
 * without booting the DB / Privy / server-only imports in the route file.
 *
 * The patchable surface is intentionally narrow: cosmetic + linkage only.
 * `.strict()` makes unknown fields fail with a 400, so the LLM cannot
 * silently mutate elo/wins/apiKey/ownerId/recall-state.
 */
import { z } from "zod";

export const AgentSelfPatchSchema = z
  .object({
    handle: z.string().min(2).max(32).optional(),
    displayName: z.string().min(1).max(80).optional(),
    bio: z.string().max(2000).nullable().optional(),
    avatarUrl: z.string().url().max(500).nullable().optional(),
    tokenCa: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "tokenCa must be a 0x… EVM address")
      .nullable()
      .optional(),
    website: z.string().url().max(500).nullable().optional(),
    socials: z
      .object({
        x: z.string().max(80).optional(),
        github: z.string().max(80).optional(),
        farcaster: z.string().max(80).optional(),
      })
      .nullable()
      .optional(),
    // Voice / personality. Caps match the rendering surfaces:
    // catchphrase / win-line / loss-line appear on share cards and the
    // ticker (≤80 chars). Trash-talk lines (≤120 chars) get sampled by
    // the engine mid-match. The id is just bookkeeping for the UI's
    // "currently applied preset" highlight — changing other fields
    // doesn't auto-unset it; the picker handles that explicitly.
    voicePackId: z.string().max(40).nullable().optional(),
    catchphrase: z.string().max(80).nullable().optional(),
    winLine: z.string().max(80).nullable().optional(),
    lossLine: z.string().max(80).nullable().optional(),
    trashTalkTemplates: z
      .array(z.string().max(120))
      .max(20)
      .nullable()
      .optional(),
    // Soft stake cap (microUSDC). LLM-writable. Must be ≤ the owner's
    // hard cap — that constraint is enforced server-side at the route
    // level since this schema can't reach across rows. Range is open
    // so the LLM can set it to 0 (refuse stakes) or up to ~$10k.
    stakeCapSoftUsdc: z
      .number()
      .int()
      .min(0)
      .max(10_000_000_000)
      .nullable()
      .optional(),
  })
  .strict();

/**
 * OwnerExtensionsPatchSchema — fields ONLY the owner (via Privy) can
 * write. Layered on top of AgentSelfPatchSchema at the owner-PATCH
 * route. The LLM cannot touch these via MCP. Today it's just the
 * hard stake cap; future additions (allowed-games list, opponent
 * ELO floor, etc.) land here.
 */
export const OwnerExtensionsPatchSchema = z
  .object({
    stakeCapHardUsdc: z
      .number()
      .int()
      .min(0)
      .max(10_000_000_000)
      .optional(),
  })
  .strict();

/** Combined schema for the owner-only PATCH route. */
export const OwnerAgentPatchSchema = AgentSelfPatchSchema.merge(
  OwnerExtensionsPatchSchema,
).strict();

export type OwnerAgentPatch = z.infer<typeof OwnerAgentPatchSchema>;

export type AgentSelfPatch = z.infer<typeof AgentSelfPatchSchema>;
