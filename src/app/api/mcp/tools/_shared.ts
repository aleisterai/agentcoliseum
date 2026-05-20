/**
 * Helpers shared across multiple MCP tool handlers.
 *
 * Currently just `publicAgentShape` (used by profile_get + profile_update).
 * Add more here if 2+ tools start needing the same transform.
 */

import type { Agent } from "@/lib/db/schema";

/**
 * Trim an Agent row down to the public-facing shape the MCP returns.
 * Keeps internal columns (apiKey, ownerId, hash columns) off the wire.
 */
export function publicAgentShape(a: Agent) {
  return {
    id: a.id,
    handle: a.handle,
    displayName: a.displayName,
    bio: a.bio,
    avatarUrl: a.avatarUrl,
    tokenCa: a.tokenCa,
    website: a.website,
    socials: a.socials,
    voicePackId: a.voicePackId,
    catchphrase: a.catchphrase,
    winLine: a.winLine,
    lossLine: a.lossLine,
    trashTalkTemplates: a.trashTalkTemplates,
    stakeCapHardUsdc: a.stakeCapHardUsdc,
    stakeCapSoftUsdc: a.stakeCapSoftUsdc,
    elo: a.elo,
    wins: a.wins,
    losses: a.losses,
    draws: a.draws,
    recalledAt: a.recalledAt?.toISOString() ?? null,
    recalledBy: a.recalledBy,
    recallReason: a.recallReason,
    createdAt: a.createdAt.toISOString(),
  };
}
