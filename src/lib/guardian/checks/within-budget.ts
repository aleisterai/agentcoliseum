/**
 * withinBudget — gates `challenge.propose` and `challenge.accept` against
 * the agent's effective per-match cap.
 *
 *   effective = min(
 *     stakeCapSoftUsdc ?? stakeCapHardUsdc,   // owner + LLM caps
 *     ownerUsdcAllowanceToOperator,            // what can actually move
 *     rookieCap (if first 5 matches),
 *   )
 *
 * Pure async check. Caller must provide the proposed stake in
 * `context.stakeUsdc` (microUSDC, 6-decimal). If null/0 (free match),
 * we pass without reading allowance — there's no money to gate.
 *
 * The denial message names which constraint bound the cap so the LLM
 * can act on it (lower stake, tell owner to top up, etc.) without
 * having to call agent.config separately.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { owners } from "@/lib/db/schema";
import { readUsdcAllowance } from "@/lib/chain/allowance";
import type { GuardianCheck } from "../types";

const ROOKIE_MATCH_THRESHOLD = 5;
const ROOKIE_CAP_USDC = 10_000_000; // $10 in microUSDC

interface CapBreakdown {
  effective: number;
  softOrHard: number;
  allowance: number;
  rookieActive: boolean;
  rookieCap: number;
  bindingConstraint: "soft" | "hard" | "allowance" | "rookie" | "free";
}

export async function computeEffectiveCap(agent: {
  ownerId: string;
  stakeCapHardUsdc: number;
  stakeCapSoftUsdc: number | null;
  wins: number;
  losses: number;
  draws: number;
}): Promise<CapBreakdown> {
  const softOrHard = agent.stakeCapSoftUsdc ?? agent.stakeCapHardUsdc;
  const ownerRow = await db.query.owners.findFirst({
    where: eq(owners.id, agent.ownerId),
  });
  const allowanceRaw = ownerRow
    ? await readUsdcAllowance(ownerRow.walletAddress as `0x${string}`)
    : 0n;
  const allowance = Number(
    allowanceRaw > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : allowanceRaw,
  );
  const totalMatches = agent.wins + agent.losses + agent.draws;
  const rookieActive = totalMatches < ROOKIE_MATCH_THRESHOLD;
  const rookieCap = rookieActive ? ROOKIE_CAP_USDC : Number.MAX_SAFE_INTEGER;

  // Pick the binding constraint (the smallest one). The label is what
  // the LLM sees, so it knows what to fix.
  const constraints: Array<[number, CapBreakdown["bindingConstraint"]]> = [
    [softOrHard, agent.stakeCapSoftUsdc != null ? "soft" : "hard"],
    [allowance, "allowance"],
    [rookieCap, "rookie"],
  ];
  constraints.sort((a, b) => a[0] - b[0]);
  const [effective, bindingConstraint] = constraints[0];

  return {
    effective,
    softOrHard,
    allowance,
    rookieActive,
    rookieCap: ROOKIE_CAP_USDC,
    bindingConstraint,
  };
}

export const withinBudget: GuardianCheck = async (action, context) => {
  // Only gate the actions that actually move money. (match.move's x402
  // fee is its own check; agent.register/fund/withdraw don't propose
  // a stake.)
  if (action !== "challenge.propose" && action !== "challenge.accept") {
    return null;
  }
  const agent = context.agent;
  if (!agent) return null;
  const stake = context.stakeUsdc ?? 0;
  // Free / system / non-paid matches: nothing to gate.
  if (stake <= 0) return null;

  const cap = await computeEffectiveCap(agent);
  if (stake <= cap.effective) return null;

  const detail =
    cap.bindingConstraint === "soft"
      ? `Your soft cap (${cap.softOrHard / 1_000_000} USDC) is below the stake. Raise it via coliseum.agent.profile_update with stakeCapSoftUsdc (max = owner's hard cap).`
      : cap.bindingConstraint === "hard"
        ? `Your hard cap (${cap.softOrHard / 1_000_000} USDC, owner-set) is below the stake. Ask the owner to raise it from the dashboard.`
        : cap.bindingConstraint === "allowance"
          ? `Owner's USDC allowance to operator (${(cap.allowance / 1_000_000).toFixed(3)} USDC) is below the stake. Owner must call USDC.approve(operator, X) for more.`
          : `Rookie-pool cap (${cap.rookieCap / 1_000_000} USDC for the first ${ROOKIE_MATCH_THRESHOLD} matches) is below the stake. Play smaller until rookie pool clears.`;

  return {
    code: "over_budget",
    message: `Stake ${stake / 1_000_000} USDC exceeds effective cap of ${cap.effective / 1_000_000} USDC. ${detail}`,
  };
};
