/**
 * coliseum_agent_wallet_link_request — first step of the two-tier
 * wallet-linking flow.
 *
 * The operator (human, sponsor, or autonomous wallet-holder) needs to
 * prove ownership of the wallet they want to link to the agent. We
 * use EIP-191 personal_sign because every wallet on every chain
 * supports it (Metamask, Rabby, hardware wallets, Privy embedded,
 * smart-account 6492 sigs, etc.) — no on-chain transaction required.
 *
 * Flow:
 *   1. Agent calls this tool (no args). Server returns a nonce + the
 *      exact UTF-8 string to sign. The nonce is stored in
 *      `wallet_link_nonces` tied to this agent with a 5-minute TTL.
 *   2. Operator signs the message with their wallet via personal_sign.
 *   3. Agent calls `coliseum_agent_wallet_connect(nonce, signature,
 *      walletAddress)` — server verifies via
 *      `viem.recoverMessageAddress`, marks the nonce consumed, sets
 *      `agents.linked_wallet_address`.
 *
 * The nonce is bound to (this agent, fresh random 32 bytes). Replay
 * attacks (using an old signature for a different agent) fail because:
 *   - The nonce row says which agent it was issued to
 *   - The message embeds the agent's handle (so a signature for agent A
 *     literally won't recover the right address for agent B)
 *   - Consumed nonces are dead — second-use rejects
 *
 * Free-tier OK: any agent can request a link, including free agents
 * that don't have a wallet yet. The linking itself is what flips
 * paid-tier eligibility on the agent row.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { walletLinkNonces } from "@/lib/db/schema";
import type { ToolDef } from "./_types";
import { toolError } from "./_shared";

const RequestArgs = z.object({}).strict();

/** Nonce TTL — 5 minutes. Long enough for the operator to switch to
 *  Metamask + sign + come back; short enough that an exfiltrated link
 *  request is useless after the operator's normal session ends. */
const NONCE_TTL_MS = 5 * 60 * 1_000;

/** Domain string baked into the signed message. If we ever fork the
 *  message format (extra fields, different prefix), bump this — old
 *  signatures with the old domain won't match. */
const SIGNING_DOMAIN = "Agent Coliseum · wallet-link · v1";

export function buildLinkMessage(args: {
  agentHandle: string;
  nonce: string;
  expiresAt: Date;
}): string {
  // The signed message is what every wallet shows in its Sign UI.
  // Keep it short, human-readable, and unambiguous about WHAT they're
  // authorizing. The operator should be able to read this and know
  // exactly what's about to happen. Includes:
  //   - Domain (so generic "sign anything" attacks fail to repurpose)
  //   - Agent handle (so the operator sees which agent they're linking)
  //   - Nonce (so each request is unique)
  //   - Expiry (so old requests can't be replayed indefinitely)
  return [
    SIGNING_DOMAIN,
    "",
    `Agent: @${args.agentHandle}`,
    `Nonce: ${args.nonce}`,
    `Expires: ${args.expiresAt.toISOString()}`,
    "",
    "Signing this message links your wallet to the agent so its",
    "$ALEISTER balance can gate paid play. No funds will move. No",
    "on-chain transaction is created.",
  ].join("\n");
}

export const agentWalletLinkRequest: ToolDef = {
  name: "coliseum_agent_wallet_link_request",
  description:
    "Step 1 of linking a wallet to this agent so it can play PAID games. Returns a nonce + a UTF-8 message that the operator signs with their wallet via personal_sign (Metamask, Rabby, ledger, Privy embedded — any wallet works). Pass the signature + wallet address back via coliseum_agent_wallet_connect within 5 minutes. NO on-chain transaction happens here — just a signature. The wallet stays in the operator's control; Coliseum only reads its $ALEISTER balance via Base RPC.\n\nNeeded for: paid challenges (≥20M $ALEISTER → first 5 games; ≥50M → unlimited). Free-mode play works without linking.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {
    title: "Issue a wallet-link signing nonce",
    // Writes a row (nonces table) but the only effect is enabling the
    // next step; nothing about the agent or wallet changes here.
    readOnlyHint: false,
    destructiveHint: false,
    // Each call produces a NEW nonce — strictly not idempotent.
    idempotentHint: false,
    // Pure DB write; no on-chain calls.
    openWorldHint: false,
  },
  async handler(args, { agent }) {
    const parsed = RequestArgs.safeParse(args);
    if (!parsed.success) {
      return toolError("validation_failed", "this tool takes no arguments", {
        details: parsed.error.flatten(),
      });
    }

    // 32 random bytes → 64 hex chars. Plenty of entropy; collisions
    // are statistically impossible at our scale.
    const nonce = randomBytes(32).toString("hex");
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);

    await db.insert(walletLinkNonces).values({
      nonce,
      agentId: agent.id,
      issuedAt,
    });

    const messageToSign = buildLinkMessage({
      agentHandle: agent.handle,
      nonce,
      expiresAt,
    });

    return {
      ok: true,
      nonce,
      expiresAt: expiresAt.toISOString(),
      messageToSign,
      signingInstructions: [
        "1. Open the wallet you want to link (Metamask, Rabby, ledger via Frame, Privy embedded, etc.).",
        "2. Call personal_sign with the exact `messageToSign` string above (no trimming, no extra newlines).",
        "3. Call coliseum_agent_wallet_connect({ nonce, signature, walletAddress }) within 5 minutes.",
        "4. The wallet's live $ALEISTER balance determines your tier — 20M unlocks first 5 paid games, 50M unlocks unlimited.",
      ].join("\n"),
      tierThresholds: {
        play: "20M $ALEISTER → first 5 paid games",
        initiator: "50M $ALEISTER → unlimited paid games",
        aleisterContract: "0xacb4543f479ea44e6df4fa01e483bb5b78361ba3",
        aleisterChain: "Base mainnet",
      },
    };
  },
};
