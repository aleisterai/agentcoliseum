/**
 * coliseum.agent.config — return the effective per-match cap + the
 * three inputs that go into it (owner hard/soft caps, on-chain USDC
 * allowance, rookie-pool status).
 *
 * Read live each call: the allowance reflects the OWNER's most recent
 * USDC.approve() to the operator, so the LLM needs the freshest value
 * before proposing a stake.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { owners } from "@/lib/db/schema";
import { readUsdcAllowance } from "@/lib/chain/allowance";
import type { ToolDef } from "./_types";

const ROOKIE_CAP_USDC = 10_000_000; // 10 USDC in microUSDC
const ROOKIE_GAME_COUNT = 5;

export const agentConfig: ToolDef = {
  name: "coliseum.agent.config",
  description:
    "Read your owner-configured spending limits + recall status. Stay within these limits — proposing over the maxStakeUsdc is rejected server-side.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handler(_args, { agent }) {
    const ownerRow = await db.query.owners.findFirst({
      where: eq(owners.id, agent.ownerId),
    });
    const allowance = ownerRow
      ? await readUsdcAllowance(ownerRow.walletAddress as `0x${string}`)
      : 0n;
    const allowanceUsdc = Number(
      allowance > BigInt(Number.MAX_SAFE_INTEGER)
        ? BigInt(Number.MAX_SAFE_INTEGER)
        : allowance,
    );
    const totalMatches = agent.wins + agent.losses + agent.draws;
    const inRookiePool = totalMatches < ROOKIE_GAME_COUNT;
    const softOrHard = agent.stakeCapSoftUsdc ?? agent.stakeCapHardUsdc;
    const effective = Math.min(
      softOrHard,
      allowanceUsdc,
      inRookiePool ? ROOKIE_CAP_USDC : Number.MAX_SAFE_INTEGER,
    );
    return {
      handle: agent.handle,
      recalled: agent.recalledAt != null,
      recallReason: agent.recallReason,
      caps: {
        stakeCapHardUsdc: agent.stakeCapHardUsdc,
        stakeCapSoftUsdc: agent.stakeCapSoftUsdc,
        onChainAllowanceUsdc: allowanceUsdc,
        rookiePoolActive: inRookiePool,
        rookieCapUsdc: ROOKIE_CAP_USDC,
        effectivePerMatchUsdc: effective,
      },
      ownerWallet: ownerRow?.walletAddress ?? null,
      operatorWallet: process.env.NEXT_PUBLIC_OPERATOR_ADDRESS ?? null,
      notice:
        "stakeCapHardUsdc is set by your owner. stakeCapSoftUsdc is yours to set via profile_update (must be ≤ hard). On-chain allowance is the owner's USDC.approve(operator) — they may need to top it up before you can stake. Rookie pool caps you at $10/match for your first 5 matches; clears automatically after.",
    };
  },
};
