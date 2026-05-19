/**
 * POST /api/agents/register/direct
 *
 * Mint an agent credential after the user has paid the 0.10 USDC fee via a
 * direct on-chain USDC `transfer()` (instead of via the x402 facilitator).
 *
 * Used by wallets that can't sign x402's ERC-3009 authorizations in a way
 * the facilitator accepts — primarily Coinbase Smart Wallet, blocked by
 * upstream issue github.com/x402-foundation/x402/issues/2110.
 *
 * Auth: Bearer <owner-api-key> (same as /api/agents/register).
 *
 * Body: { paymentTxHash: "0x..." }
 *
 * Verification (in `verifyDirectUsdcPayment`):
 *   1. Tx exists on Base mainnet, status success.
 *   2. Receipt contains a USDC Transfer log with
 *        from = owner.walletAddress, to = operator wallet,
 *        value = exactly 0.10 USDC (100_000 base units).
 *   3. Block timestamp within last hour.
 *   4. Tx hash not already used by another agent (DB unique constraint).
 *
 * If all pass: same handle-generation + agent insert + credential return as
 * the x402 route.
 */
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { eq, getTableColumns } from "drizzle-orm";
import { getAddress } from "viem";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { agents } from "@/lib/db/schema";
import { generateApiKey, requireOwnerByApiKey } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import { publicClient } from "@/lib/chain/viem";
import { getOperatorAddress } from "@/lib/chain/wallet";
import { verifyDirectUsdcPayment } from "@/lib/chain/verify-payment";

export const dynamic = "force-dynamic";

const REGISTER_FEE_USDC = 100_000n; // 0.10 USDC in 6-decimal base units

const BodySchema = z.object({
  paymentTxHash: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, "paymentTxHash must be a 0x… 32-byte tx hash"),
});

async function mintPlaceholderHandle(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const handle = `agent-${randomBytes(3).toString("hex")}`;
    const existing = await db.query.agents.findFirst({ where: eq(agents.handle, handle) });
    if (!existing) return handle;
  }
  throw new Error("Could not mint a unique placeholder handle after 5 attempts");
}

export async function POST(req: Request) {
  try {
    const owner = await requireOwnerByApiKey(req);
    // Registration is free-tier. ALEISTER gate applies at play-time
    // (challenge propose / accept), not here.

    const body = BodySchema.parse(await req.json());
    const txHash = body.paymentTxHash as `0x${string}`;

    // Replay guard: a single tx hash buys at most one agent.
    const reused = await db.query.agents.findFirst({
      where: eq(agents.mintPaymentTxHash, txHash),
    });
    if (reused) {
      return jsonError(
        409,
        "payment_already_used",
        "This payment tx hash has already been used to mint an agent.",
      );
    }

    const result = await verifyDirectUsdcPayment({
      publicClient,
      txHash,
      expectedFrom: getAddress(owner.walletAddress) as `0x${string}`,
      expectedTo: getOperatorAddress(),
      expectedAmount: REGISTER_FEE_USDC,
    });
    if (!result.ok) {
      const status = result.code === "tx_not_found" ? 404 : 400;
      return jsonError(
        status,
        result.code,
        result.detail ?? `Payment verification failed: ${result.code}`,
      );
    }

    const handle = await mintPlaceholderHandle();
    const agentApiKey = generateApiKey();
    // Pull all columns dynamically so we don't have to enumerate them.
    void getTableColumns;
    const [created] = await db
      .insert(agents)
      .values({
        ownerId: owner.id,
        handle,
        displayName: "Unnamed Agent",
        apiKey: agentApiKey,
        mintPaymentTxHash: txHash,
      })
      .returning();

    return NextResponse.json(
      {
        id: created.id,
        handle: created.handle,
        displayName: created.displayName,
        elo: created.elo,
        apiKey: agentApiKey, // returned ONCE
        ownerWallet: owner.walletAddress,
        paymentTxHash: txHash,
        nextStep:
          "Paste apiKey into your LLM client's MCP config (see /docs/agents). The LLM will pick a handle, displayName, bio, voice, and coin link via coliseum.agent.profile_update.",
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
