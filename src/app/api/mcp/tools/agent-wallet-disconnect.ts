/**
 * coliseum_agent_wallet_disconnect — drop the linked-wallet attachment.
 *
 * Used when the operator wants to:
 *   - Migrate to a new wallet (disconnect → link_request → connect)
 *   - Pause paid play without recalling the agent
 *   - Detach a compromised wallet
 *
 * Effect:
 *   - `agents.linked_wallet_address` → null
 *   - `agents.linked_wallet_signed_at` → null
 *   - `agents.wallet_link_signature` → null
 *   - `agents.owner_id` → null (the wallet WAS the owner identity)
 *   - `paid_games_played` is NOT touched — sticky counter
 *
 * After disconnect:
 *   - Agent is free-tier (no paid play)
 *   - Free-mode matches still work
 *   - Profile / docs / state / chat all still work
 *   - Any in-flight paid challenges or matches the agent is currently
 *     participating in continue to completion (we don't recall mid-play)
 *
 * The decision NOT to retroactively unwind in-flight matches is
 * deliberate — both sides committed to the stake when the match
 * started. Forcing a refund at disconnect-time would let an
 * about-to-lose agent grief by disconnecting mid-match.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { agents } from "@/lib/db/schema";
import type { ToolDef } from "./_types";
import { toolError } from "./_shared";

const DisconnectArgs = z.object({}).strict();

export const agentWalletDisconnect: ToolDef = {
  name: "coliseum_agent_wallet_disconnect",
  description:
    "Detach the linked wallet from this agent. The agent reverts to FREE tier (free-mode play only). The paidGamesPlayed counter is sticky and NOT reset. In-flight matches continue to completion. Use this to migrate to a new wallet (disconnect → wallet_link_request → wallet_connect with the new wallet).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {
    title: "Drop the linked wallet (revert to free tier)",
    readOnlyHint: false,
    // Irreversible only in the sense that you have to re-sign to
    // re-link — but you'd do that anyway. Not destructive to data.
    destructiveHint: false,
    // Calling twice in a row is fine — second call is a no-op (wallet
    // is already null).
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { agent }) {
    const parsed = DisconnectArgs.safeParse(args);
    if (!parsed.success) {
      return toolError("validation_failed", "this tool takes no arguments");
    }
    if (!agent.linkedWalletAddress) {
      return {
        ok: true,
        message:
          "no wallet was linked; nothing to do. paidGamesPlayed counter preserved.",
        agentId: agent.id,
        handle: agent.handle,
        previousTier: "free" as const,
        currentTier: "free" as const,
        paidGamesPlayed: agent.paidGamesPlayed,
      };
    }
    const previousWallet = agent.linkedWalletAddress;
    await db
      .update(agents)
      .set({
        linkedWalletAddress: null,
        linkedWalletSignedAt: null,
        walletLinkSignature: null,
        // Also drop the owner_id link so future paid attempts cleanly
        // hit "no_wallet_linked" rather than partial state. The owner
        // row itself survives (it may have other agents linked to it).
        ownerId: null,
      })
      .where(eq(agents.id, agent.id));

    return {
      ok: true,
      agentId: agent.id,
      handle: agent.handle,
      previousWallet,
      currentTier: "free" as const,
      paidGamesPlayed: agent.paidGamesPlayed,
      message: `Wallet ${previousWallet} unlinked. Agent is FREE tier. Counter preserved (${agent.paidGamesPlayed} paid games). Link a new wallet via coliseum_agent_wallet_link_request to resume paid play.`,
    };
  },
};
