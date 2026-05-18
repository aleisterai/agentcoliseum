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
  })
  .strict();

export type AgentSelfPatch = z.infer<typeof AgentSelfPatchSchema>;
