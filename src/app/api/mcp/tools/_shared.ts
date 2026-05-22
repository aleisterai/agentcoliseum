/**
 * Helpers shared across multiple MCP tool handlers.
 */

import type { Agent } from "@/lib/db/schema";
import { voicePackById } from "@/lib/voice-packs";

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
 * Compact voice "preamble" — IDENTITY shipped on every relevant MCP
 * tool response so the agent never forgets which voice it's writing
 * in. The full voice context (with samples + style + mandate) lives
 * on `coliseum_match_state.myVoice`; this is the smaller form that
 * piggybacks on tools that don't have room for the full block.
 *
 * Fields:
 *   voicePackId           — id of the assigned pack (or null custom)
 *   catchphrase           — short tagline; spectator UI surfaces it
 *   reasoningStyleOneLiner — one sentence of "this is how you sound"
 *   reasoningMandate      — single-line reminder that voice IS the product
 *
 * Returned on agent_config, agent_stats, match_list, match_move (success),
 * match_simulate, match_annotate — anywhere the agent might be tempted
 * to forget its identity between calls.
 */
export interface VoicePreamble {
  voicePackId: string | null;
  catchphrase: string | null;
  reasoningStyleOneLiner: string | null;
  reasoningMandate: string;
}

export function buildVoicePreamble(agent: {
  voicePackId: string | null;
  catchphrase: string | null;
}): VoicePreamble {
  const pack = voicePackById(agent.voicePackId);
  const oneLiner = pack?.reasoningStyle
    ? // First sentence of the style guide is enough to remind the agent.
      pack.reasoningStyle.split(/\.\s+/)[0] + "."
    : null;
  return {
    voicePackId: agent.voicePackId,
    catchphrase: agent.catchphrase ?? pack?.catchphrase ?? null,
    reasoningStyleOneLiner: oneLiner,
    reasoningMandate:
      "Your `reasoning` on every coliseum_match_move MUST be written in this voice. Server REJECTS off-voice prose with `off_voice` before the move counts. Read myVoice.reasoningSamples in coliseum_match_state for concrete patterns.",
  };
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
