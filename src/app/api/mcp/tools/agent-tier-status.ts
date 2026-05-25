/**
 * coliseum_agent_tier_status — diagnostic dump of the agent's
 * paid-play eligibility.
 *
 * Returns the same data structure the tier gate would compute on a
 * paid action, BUT without rejecting if the agent doesn't qualify.
 * The LLM uses this to decide whether to attempt paid play OR to
 * surface the upgrade hint to its operator first.
 *
 * Free-tier OK: called before any wallet is linked. Returns the
 * "no wallet linked" structure so the LLM can show the upgrade
 * instructions.
 *
 * Read-only: no state mutations.
 */

import { z } from "zod";
import { PLAY_TIER_GAME_CAP, requirePlayAccess } from "@/lib/chain/tiers";
import type { ToolDef } from "./_types";
import { toolError } from "./_shared";

const TierStatusArgs = z.object({}).strict();

export const agentTierStatus: ToolDef = {
  name: "coliseum_agent_tier_status",
  description:
    "Read the agent's current paid-play tier. Returns linked wallet address, live $ALEISTER balance (60s-cached), tier (free / play / initiator), paidGamesPlayed counter, and remaining paid-game allowance for Play tier. Use BEFORE attempting paid actions so you can surface the upgrade flow to your operator if needed.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {
    title: "Read paid-play tier status",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    // Reads $ALEISTER balance (cached but cache miss hits Base RPC).
    openWorldHint: true,
  },
  async handler(args, { agent }) {
    const parsed = TierStatusArgs.safeParse(args);
    if (!parsed.success) {
      return toolError("validation_failed", "this tool takes no arguments");
    }

    const access = await requirePlayAccess({
      id: agent.id,
      handle: agent.handle,
      linkedWalletAddress: agent.linkedWalletAddress,
      paidGamesPlayed: agent.paidGamesPlayed,
    });

    const thresholds = {
      playAleister: "20M",
      initiatorAleister: "50M",
      playGameCap: PLAY_TIER_GAME_CAP,
      aleisterContract: "0xacb4543f479ea44e6df4fa01e483bb5b78361ba3",
      aleisterChain: "Base mainnet",
    };

    if (access.ok) {
      return {
        ok: true,
        agentId: agent.id,
        handle: agent.handle,
        linkedWallet: access.wallet,
        aleisterBalanceWei: access.balanceWei.toString(),
        aleisterBalanceFormatted: access.balanceFormatted,
        balanceCheckedAt: access.cachedAt.toISOString(),
        balanceFromCache: access.fromCache,
        tier: access.tier,
        paidGamesPlayed: access.paidGamesPlayed,
        paidGamesRemaining: access.paidGamesRemaining,
        canProposePaid: true,
        canAcceptPaid: true,
        canMovePaid: true,
        thresholds,
      };
    }

    // Denied — surface the same details + hint the tier gate would emit.
    return {
      ok: true,
      agentId: agent.id,
      handle: agent.handle,
      linkedWallet: agent.linkedWalletAddress,
      tier:
        access.code === "no_wallet_linked"
          ? ("free" as const)
          : access.code === "tier_below_play"
            ? ("free" as const)
            : ("play" as const),
      paidGamesPlayed: agent.paidGamesPlayed,
      paidGamesRemaining: 0,
      canProposePaid: false,
      canAcceptPaid: false,
      canMovePaid: false,
      reason: {
        code: access.code,
        message: access.message,
        hint: access.hint,
        ...access.details,
      },
      thresholds,
    };
  },
};
