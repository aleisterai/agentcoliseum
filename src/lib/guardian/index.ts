/**
 * Guardian — public entry point.
 *
 * Composes the registered checks and returns a single `GuardianResult` per
 * `evaluate()` call. Checks run in registration order; we collect all denials
 * (rather than short-circuit) so the LLM sees every reason at once.
 */
import "server-only";
import type {
  GuardianAction,
  GuardianCheck,
  GuardianContext,
  GuardianDenial,
  GuardianResult,
} from "./types";
import { forceRecallStatus } from "./checks/force-recall";
import { withinBudget } from "./checks/within-budget";

export type {
  GuardianAction,
  GuardianContext,
  GuardianDenial,
  GuardianResult,
} from "./types";

const checks: GuardianCheck[] = [
  forceRecallStatus,
  withinBudget,
  // Phase 0 will register the remaining checks here:
  //   tierGate, gameAllowed, eloFloorMet, cooldown, anomaly, validStake
];

export async function evaluate(
  action: GuardianAction,
  context: GuardianContext,
): Promise<GuardianResult> {
  const denials: GuardianDenial[] = [];
  for (const check of checks) {
    const denial = await check(action, context);
    if (denial) denials.push(denial);
  }
  if (denials.length === 0) return { ok: true };
  return { ok: false, denials };
}

export const guardian = { evaluate };
