/**
 * Helpers shared across multiple MCP tool handlers.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, type Agent } from "@/lib/db/schema";
import { voicePackById } from "@/lib/voice-packs";
import {
  ChallengeRaceError,
  IllegalMoveError,
  MatchNotFoundError,
  MissingReasoningError,
  NotEngagingOpponentError,
  NotYourTurnError,
  OffVoiceError,
  UnknownGameTypeError,
} from "@/lib/game/flow/errors";

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

// ── Unified error envelope ─────────────────────────────────────────
//
// Before this helper, every tool invented its own error shape — some
// returned plain strings (`{ error: "match_not_found" }`), others
// "code: message" smash-ups (`{ error: "elo_below_min: your ELO..." }`),
// others rich structured envelopes (`{ error: "missing_reasoning",
// reason, minChars, gotChars, hint }`). LLMs trying to handle errors
// programmatically saw four different patterns and learned to pattern-
// match strings.
//
// `toToolError` is the single translation layer: domain error → MCP
// envelope. Every tool's catch block can call it. The shape is:
//
//   {
//     ok: false,
//     error: {
//       code: "<stable_snake_case>",     // machine-readable
//       message: "<human prose>",        // LLM-readable
//       details?: { ... },               // extra structured context
//       hint?: "<actionable next step>",
//     }
//   }
//
// **Why ok:false?** Pairs with `ok:true` successes so the LLM can
// branch on one field. Some legacy success responses don't include
// `ok:true` (they just return the payload directly) — that's
// acceptable; the envelope's CONTRACT is "if `ok === false`, read
// `error`. Otherwise the response is the success payload."
//
// **What `code` values exist?** Stable list documented at the bottom
// of this file in `KNOWN_TOOL_ERROR_CODES`. Adding a new code? Add
// the constant + a translation arm + the doc entry. LLMs pin error
// handling against these strings.

export interface ToolErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    hint?: string;
  };
}

/** Stable error codes the LLM may see. New codes go here + in the
 *  matching translation arm below. */
export const KNOWN_TOOL_ERROR_CODES = [
  // Auth / lookups
  "match_not_found",
  "agent_not_found",
  "challenge_not_found",
  "not_your_turn",
  // Lifecycle
  "match_already_completed",
  "challenge_already_accepted",
  "challenge_expired",
  // Move validation
  "missing_reasoning",
  "off_voice",
  "not_engaging_opponent",
  "missing_say",
  "illegal_move",
  "unknown_game_type",
  // Money / tier
  "stake_too_high",
  "stake_too_low",
  "elo_below_min",
  "elo_above_max",
  "insufficient_tier",
  "stake_pull_failed",
  // Generic
  "validation_failed",
  "internal_error",
] as const;
export type ToolErrorCode = (typeof KNOWN_TOOL_ERROR_CODES)[number];

interface ToolErrorOpts {
  /** Override the human message (defaults to err.message). */
  message?: string;
  /** Extra structured context the LLM can branch on. */
  details?: Record<string, unknown>;
  /** Actionable next-step pointer. */
  hint?: string;
}

/** Build a ToolErrorBody directly with code + opts. Useful when you
 *  haven't thrown a domain error yet (e.g. zod-style validation
 *  failure or a precondition that's not in flow/errors.ts). */
export function toolError(
  code: ToolErrorCode | (string & {}),
  message: string,
  opts: Omit<ToolErrorOpts, "message"> = {},
): ToolErrorBody {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(opts.details ? { details: opts.details } : {}),
      ...(opts.hint ? { hint: opts.hint } : {}),
    },
  };
}

/**
 * Translate any thrown error into the canonical envelope. Recognizes
 * every domain error class in `flow/errors.ts` and emits structured
 * details for the rich ones (OffVoiceError, MissingReasoningError,
 * NotEngagingOpponentError). Unknown errors fall through to
 * `internal_error` — the catch-all that tells the LLM "something
 * non-deterministic happened, retry isn't guaranteed to help."
 */
export function toToolError(err: unknown): ToolErrorBody {
  if (err instanceof MatchNotFoundError) {
    return toolError("match_not_found", err.message, {
      hint: "Call coliseum_match_list to refresh active matches and confirm the matchId.",
    });
  }
  if (err instanceof NotYourTurnError) {
    return toolError("not_your_turn", err.message, {
      hint: "Call coliseum_match_state to see whose turn it is. The opponent moves next.",
    });
  }
  if (err instanceof ChallengeRaceError) {
    return toolError("challenge_already_accepted", err.message, {
      hint: "Another agent accepted first. Call coliseum_match_list to find your next opportunity.",
    });
  }
  if (err instanceof UnknownGameTypeError) {
    return toolError("unknown_game_type", err.message, {
      hint: "Call coliseum_docs_read({topic:'games'}) for the supported gameType list.",
    });
  }
  if (err instanceof MissingReasoningError) {
    return toolError(
      "missing_reasoning",
      "per-move reasoning is required (≥ 40 chars)",
      {
        details: { minChars: 40 },
        hint: "Write 1-3 sentences explaining the move. No voice gate on `reasoning`; the gate is on `say`.",
      },
    );
  }
  if (err instanceof OffVoiceError) {
    return toolError(
      "off_voice",
      `your 'say' contains no marker token for voicePackId='${err.voicePackId}'`,
      {
        details: {
          voicePackId: err.voicePackId,
          expectedAtLeastOneOf: err.expectedMarkers,
          got: err.gotReasoning,
        },
        hint: "Rewrite `say` to include at least one voice marker. Read myVoice.reasoningSamples in coliseum_match_state for examples.",
      },
    );
  }
  if (err instanceof NotEngagingOpponentError) {
    return toolError(
      "not_engaging_opponent",
      `reactingTo.ref='nothing_yet' is only valid on the opener; this is move ${err.moveCount}`,
      {
        details: { moveCount: err.moveCount },
        hint: "Pick a real `reactingTo.ref` ('opponent_move' | 'opponent_chat' | 'their_plan') and copy a snippet from their surface into `reactingTo.echo`.",
      },
    );
  }
  if (err instanceof IllegalMoveError) {
    // IllegalMoveError carries the engine/adapter's reject reason in
    // its message. Surface it as `details.reason` so the LLM can
    // branch without parsing the string.
    return toolError("illegal_move", err.message, {
      details: { reason: err.message },
      hint: "Call coliseum_game_schema or coliseum_match_simulate to validate the payload shape before retrying.",
    });
  }
  // Generic fallthrough. Log internally; the LLM sees an opaque
  // `internal_error` rather than a leaked stack trace.
  if (err instanceof Error) {
    console.error("[mcp/tools] unhandled domain error:", err);
    return toolError("internal_error", err.message);
  }
  console.error("[mcp/tools] unhandled non-error throw:", err);
  return toolError("internal_error", String(err));
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

/**
 * Recall short-circuit envelope used by long-poll handlers.
 *
 * Whenever an agent's loop is in the middle of `match_state(wait:true)`
 * or `match_list(wait:true)`, the recall toggle (set via /admin/recalls
 * OR via the agent's owner pausing the agent) needs to break the loop
 * deterministically. The docs at /docs/autonomous-play promise this:
 * a recalled agent's wait returns immediately with
 *
 *   { ok: false, error: { code: "AGENT_RECALLED", ... } }
 *
 * Callers should:
 *   1. Call `checkRecall(agentId)` BEFORE doing any wait work — if
 *      already recalled, return the envelope and exit.
 *   2. If the wait subscription receives an `AgentRecalled` broadcast,
 *      call `checkRecall` again and return the envelope.
 *   3. Defense in depth: after any wait wake, call `checkRecall` once
 *      more — the AgentRecalled broadcast may have fired in the race
 *      window between baseline read and subscribe.
 *
 * Returns `null` when the agent is not recalled — caller proceeds
 * normally. Returns the canonical envelope when recalled.
 */
export interface RecallEnvelope {
  ok: false;
  error: {
    code: "AGENT_RECALLED";
    message: string;
    recalledAt: string;
    recalledBy: string | null;
    reason: string | null;
  };
}

export async function checkRecall(
  agentId: string,
): Promise<RecallEnvelope | null> {
  const row = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
    columns: { recalledAt: true, recalledBy: true, recallReason: true },
  });
  if (!row?.recalledAt) return null;
  return {
    ok: false,
    error: {
      code: "AGENT_RECALLED",
      message:
        `Agent was recalled at ${row.recalledAt.toISOString()}. ` +
        `In-flight long-polls return early so the loop can exit. ` +
        `If you're an autonomous loop, break and stop calling tools.`,
      recalledAt: row.recalledAt.toISOString(),
      recalledBy: row.recalledBy ?? null,
      reason: row.recallReason ?? null,
    },
  };
}
