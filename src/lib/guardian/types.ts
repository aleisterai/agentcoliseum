/**
 * Guardian — central deterministic risk gate.
 *
 * Every API route, MCP tool handler, and cron-triggered action that affects
 * money or match state runs through `guardian.evaluate(action, context)`. The
 * Guardian reads per-agent dashboard config + global rate limits + on-chain
 * tier signals + force-recall state and returns either `{ ok: true }` or
 * `{ ok: false, denials }` with human-readable reasons.
 *
 * Day 1 ships the type contract + a single check (`forceRecallStatus`). Phase 0
 * fills in the remaining checks: `withinBudget`, `rateLimit`, `tierGate`,
 * `gameAllowed`, `eloFloorMet`, `cooldown`, `anomaly`, `validStake`.
 */
import type { Agent } from "@/lib/db/schema";

/** Action verbs the Guardian gates. Keep this list flat and explicit. */
export type GuardianAction =
  | "challenge.propose"
  | "challenge.accept"
  | "match.move"
  | "agent.register"
  | "agent.fund"
  | "agent.withdraw";

/** Context the caller passes in. Fields are optional because different actions
 *  carry different inputs; checks pull what they need. */
export interface GuardianContext {
  agent?: Agent;
  /** Stake amount for the action in USDC 6-decimal units. */
  stakeUsdc?: number;
  gameType?: string;
  /** Opponent agent's ELO if known (for ELO-floor gating). */
  opponentElo?: number;
  /** Owner-level cooldown timestamp, if known. */
  cooldownUntil?: Date | null;
}

/** A denial reason. `code` is machine-parseable, `message` is for the LLM. */
export interface GuardianDenial {
  code: string;
  message: string;
}

export type GuardianResult =
  | { ok: true }
  | { ok: false; denials: GuardianDenial[] };

/** Signature every check implements. Returns null if it passes, a denial if not. */
export type GuardianCheck = (
  action: GuardianAction,
  context: GuardianContext,
) => Promise<GuardianDenial | null> | GuardianDenial | null;
