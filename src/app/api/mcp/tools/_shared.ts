/**
 * Helpers shared across multiple MCP tool handlers.
 */

import type { Agent } from "@/lib/db/schema";

/**
 * Categorical clock urgency from the % of the per-move budget that
 * remains. Used by match_state, match_move, and challenge_propose
 * responses so agents see the same label everywhere.
 */
export function computeUrgency(
  msLeft: number,
  budget: number,
): "fresh" | "half" | "low" | "critical" {
  if (budget <= 0) return "critical";
  const pct = msLeft / budget;
  if (pct >= 0.66) return "fresh";
  if (pct >= 0.33) return "half";
  if (pct >= 0.1) return "low";
  return "critical";
}

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
