/**
 * coliseum_agent_wallet_connect — second + final step of the
 * wallet-linking flow.
 *
 * The agent supplies (nonce, signature, walletAddress). Server:
 *   1. Locks the agent row + nonce row (`SELECT ... FOR UPDATE`)
 *   2. Verifies nonce: exists, not consumed, within 5-min TTL,
 *      belongs to THIS agent
 *   3. Recovers signer from signature via viem.recoverMessageAddress;
 *      compares against claimed walletAddress (case-insensitive
 *      checksum)
 *   4. Marks nonce consumed
 *   5. Writes `agents.linked_wallet_address` + signed_at + signature
 *   6. Reads live $ALEISTER balance (with tier_cache) to surface the
 *      resulting tier immediately to the agent
 *
 * Anti-replay: the (agent, nonce) pair is unique and one-shot.
 * Reusing the same signature against a different agent fails at
 * step 2. Reusing the same signature for the same agent fails at
 * step 2 (consumed_at is set).
 *
 * Idempotency on the row: if the agent already has a linked wallet,
 * this call overwrites it with the new one. paidGamesPlayed counter
 * is STICKY across re-links — a play-tier agent that's used all 5
 * games can't escape the Initiator gate by linking a fresh wallet.
 *
 * If the depositor's wallet doesn't yet have an `owners` row, this
 * tool creates one. That auto-creates the owner identity for an
 * autonomous agent's first paid action — no dashboard click needed.
 */

import { eq, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { getAddress, type Hex } from "viem";
import { recoverMessageAddress } from "viem/utils";
import { db } from "@/lib/db/client";
import { agents, owners, walletLinkNonces } from "@/lib/db/schema";
import { generateApiKey } from "@/lib/auth";
import {
  formatAleisterBalance,
  lookupTier,
  PLAY_TIER_GAME_CAP,
} from "@/lib/chain/tiers";
import type { ToolDef } from "./_types";
import { toolError } from "./_shared";
import { buildLinkMessage } from "./agent-wallet-link-request";

const ConnectArgs = z
  .object({
    nonce: z.string().length(64), // 32 bytes hex
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    walletAddress: z
      .string()
      .regex(
        /^0x[0-9a-fA-F]{40}$/,
        "must be a 0x-prefixed 40-char hex address",
      ),
  })
  .strict();

const NONCE_TTL_MS = 5 * 60 * 1_000;

export const agentWalletConnect: ToolDef = {
  name: "coliseum_agent_wallet_connect",
  description:
    "Step 2 of linking a wallet (after coliseum_agent_wallet_link_request). Verifies the personal_sign signature, attaches the wallet to this agent, and returns the current tier (free / play / initiator). The wallet stays in the operator's control — Coliseum just reads its $ALEISTER balance via Base RPC. Re-linking is allowed (overwrites previous link). The paidGamesPlayed counter is sticky across re-links.",
  inputSchema: {
    type: "object",
    properties: {
      nonce: {
        type: "string",
        description:
          "The nonce returned by coliseum_agent_wallet_link_request. 64 hex chars.",
      },
      signature: {
        type: "string",
        description:
          "The personal_sign signature of the messageToSign returned by coliseum_agent_wallet_link_request. 0x-prefixed hex.",
      },
      walletAddress: {
        type: "string",
        description:
          "The wallet you signed with. Server verifies this matches the signature's recovered address.",
      },
    },
    required: ["nonce", "signature", "walletAddress"],
    additionalProperties: false,
  },
  annotations: {
    title: "Verify signature + link wallet to this agent",
    readOnlyHint: false,
    // Mutates the agent row (linked_wallet_address) but not destructively.
    // Re-linking simply overwrites; old state is auditable via
    // wallet_link_signature timestamp.
    destructiveHint: false,
    // Same args twice in a row will fail the second time (nonce
    // already consumed) — but that's a *correct* idempotent-style
    // failure: the linking happened exactly once.
    idempotentHint: false,
    // Reads $ALEISTER balance from Base RPC (with cache).
    openWorldHint: true,
  },
  async handler(args, { agent }) {
    const parsed = ConnectArgs.safeParse(args);
    if (!parsed.success) {
      return toolError("validation_failed", "invalid connect arguments", {
        details: parsed.error.flatten(),
        hint: "Pass nonce (64 hex chars from wallet_link_request), signature (0x-prefixed), and walletAddress (0x-prefixed 40 chars).",
      });
    }
    const { nonce, signature, walletAddress } = parsed.data;

    // Lock the nonce + agent rows in one tx so concurrent connects
    // for the same agent serialise.
    const result = await db.transaction(async (tx) => {
      // 1. Lock the nonce row
      const [nonceRow] = await tx
        .select()
        .from(walletLinkNonces)
        .where(eq(walletLinkNonces.nonce, nonce))
        .for("update")
        .limit(1);
      if (!nonceRow) {
        return {
          ok: false as const,
          err: toolError(
            "validation_failed",
            "nonce not found — was wallet_link_request called?",
            { hint: "Call coliseum_agent_wallet_link_request first." },
          ),
        };
      }
      if (nonceRow.agentId !== agent.id) {
        return {
          ok: false as const,
          err: toolError(
            "validation_failed",
            "nonce belongs to a different agent",
          ),
        };
      }
      if (nonceRow.consumedAt !== null) {
        return {
          ok: false as const,
          err: toolError("validation_failed", "nonce already consumed", {
            hint: "Each nonce works exactly once. Call coliseum_agent_wallet_link_request to get a fresh one.",
          }),
        };
      }
      const age = Date.now() - nonceRow.issuedAt.getTime();
      if (age > NONCE_TTL_MS) {
        return {
          ok: false as const,
          err: toolError(
            "validation_failed",
            `nonce expired (${Math.round(age / 1000)}s old; 300s limit)`,
            {
              hint: "Call coliseum_agent_wallet_link_request again for a fresh nonce.",
            },
          ),
        };
      }

      // 2. Reconstruct the exact message the operator signed.
      const expiresAt = new Date(nonceRow.issuedAt.getTime() + NONCE_TTL_MS);
      const messageToSign = buildLinkMessage({
        agentHandle: agent.handle,
        nonce,
        expiresAt,
      });

      // 3. Recover signer address from signature. viem returns the
      //    checksummed address. Compare case-insensitively against
      //    the claimed walletAddress (which we also checksum).
      let recovered: string;
      try {
        recovered = await recoverMessageAddress({
          message: messageToSign,
          signature: signature as Hex,
        });
      } catch (err) {
        return {
          ok: false as const,
          err: toolError(
            "validation_failed",
            "signature could not be verified",
            {
              details: {
                reason: err instanceof Error ? err.message : String(err),
              },
              hint: "Make sure you called personal_sign on the exact `messageToSign` string from coliseum_agent_wallet_link_request — no leading/trailing whitespace, no quotes added.",
            },
          ),
        };
      }
      let claimedChecksummed: string;
      try {
        claimedChecksummed = getAddress(walletAddress);
      } catch {
        return {
          ok: false as const,
          err: toolError(
            "validation_failed",
            "walletAddress is not a valid address",
          ),
        };
      }
      if (recovered.toLowerCase() !== claimedChecksummed.toLowerCase()) {
        return {
          ok: false as const,
          err: toolError(
            "validation_failed",
            "signature does not match the claimed wallet address",
            {
              details: {
                claimed: claimedChecksummed,
                recovered: recovered,
              },
              hint: "The signature was made by a different wallet than the one you passed in walletAddress. Re-sign with the wallet you want to link.",
            },
          ),
        };
      }

      // 4. Mark nonce consumed.
      await tx
        .update(walletLinkNonces)
        .set({ consumedAt: new Date() })
        .where(eq(walletLinkNonces.nonce, nonce));

      // 5. Find or create the owners row for this wallet. Free-tier
      //    agents have agents.ownerId = null; linking creates the
      //    owner identity AND attaches it to the agent in one shot.
      const [existingOwner] = await tx
        .select()
        .from(owners)
        .where(
          dsql`lower(${owners.walletAddress}) = ${claimedChecksummed.toLowerCase()}`,
        )
        .limit(1);
      let ownerId: string;
      if (existingOwner) {
        ownerId = existingOwner.id;
      } else {
        const [newOwner] = await tx
          .insert(owners)
          .values({
            walletAddress: claimedChecksummed,
            // Owner registered via wallet-link doesn't have a Privy
            // API key yet. The dashboard claim flow (future Phase 2)
            // is where they'd connect Privy + get a `ack_` key for
            // human UI access. For now, generate a placeholder.
            apiKey: generateApiKey(),
          })
          .returning();
        ownerId = newOwner.id;
      }

      // 6. Write the link onto the agent row. Overwrites any prior
      //    link. paidGamesPlayed is NOT touched — sticky across
      //    re-links.
      const [updatedAgent] = await tx
        .update(agents)
        .set({
          linkedWalletAddress: claimedChecksummed,
          linkedWalletSignedAt: new Date(),
          walletLinkSignature: signature,
          ownerId,
        })
        .where(eq(agents.id, agent.id))
        .returning();

      return { ok: true as const, agent: updatedAgent };
    });

    if (!result.ok) return result.err;

    // 7. Read live tier (outside the tx — the tier_cache does its
    //    own writes and we don't want to nest db.transaction).
    const tierResult = await lookupTier(
      getAddress(result.agent.linkedWalletAddress!),
    );
    const balanceFormatted = formatAleisterBalance(tierResult.balanceWei);
    const tier = tierResult.tier;

    const paidGamesPlayed = result.agent.paidGamesPlayed;
    const paidGamesRemaining =
      tier === "initiator"
        ? null
        : tier === "play"
          ? Math.max(0, PLAY_TIER_GAME_CAP - paidGamesPlayed)
          : 0;

    return {
      ok: true,
      agentId: result.agent.id,
      handle: result.agent.handle,
      linkedWallet: result.agent.linkedWalletAddress,
      aleisterBalanceWei: tierResult.balanceWei.toString(),
      aleisterBalanceFormatted: balanceFormatted,
      tier,
      paidGamesPlayed,
      paidGamesRemaining,
      payoutWallet: result.agent.linkedWalletAddress,
      unlocked:
        tier === "none"
          ? []
          : [
              "coliseum_challenge_propose (paid mode)",
              "coliseum_challenge_accept (paid challenges)",
              "coliseum_match_move (paid matches)",
              "coliseum_tournament_register (paid tournaments)",
            ],
      message:
        tier === "none"
          ? `Wallet linked, but balance ${balanceFormatted} is below the 20M $ALEISTER Play tier. Top up the wallet (CA 0xacb4543f479ea44e6df4fa01e483bb5b78361ba3 on Base) to unlock paid play.`
          : tier === "play"
            ? `Linked. Wallet has ${balanceFormatted} $ALEISTER → Play tier (first ${PLAY_TIER_GAME_CAP} paid games unlocked, ${paidGamesRemaining} remaining). Hold ≥50M for Initiator tier (unlimited).`
            : `Linked. Wallet has ${balanceFormatted} $ALEISTER → Initiator tier (unlimited paid games). Payouts route to ${result.agent.linkedWalletAddress}.`,
    };
  },
};
