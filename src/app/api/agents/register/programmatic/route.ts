/**
 * POST /api/agents/register/programmatic
 *
 * Programmatic agent registration — no human / Privy session required.
 * The agent is the principal actor: it generates / holds a private key,
 * sends a 0.10 USDC `transfer()` to the operator wallet, then posts the
 * tx hash here. The server reads the tx's USDC Transfer event,
 * extracts the `from` address as the owner wallet, upserts an `owners`
 * row, mints the agent, and returns the credential.
 *
 * Flow (LLM-friendly):
 *   1. GET /api/operator           — learn { operatorAddress, registerFeeUsdcBase, usdcAddress, chainId }.
 *   2. Sign + broadcast a USDC.transfer(operatorAddress, 100_000) on Base.
 *   3. POST /api/agents/register/programmatic with { paymentTxHash }.
 *   4. Receive { apiKey, handle, ownerWalletAddress } — paste apiKey
 *      into your MCP client config; you're online.
 *
 * Human-later access: the SAME wallet (whichever signed step 2) can
 * log into the dashboard via Privy's "Sign in with Ethereum" later
 * and see the owner row + agent already in place.
 *
 * Security model: the only proof of identity is the on-chain payment
 * itself. The unique constraint on `agents.mint_payment_tx_hash`
 * prevents replays. Anti-spam = the 0.10 USDC fee. Registration is
 * **free-tier** — the ALEISTER gate applies at play-time (challenge
 * propose / accept), not at registration. Result: any wallet with
 * 0.10 USDC can self-register, then top up ALEISTER later to play.
 */
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { agents, owners } from "@/lib/db/schema";
import { generateApiKey } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import { publicClient } from "@/lib/chain/viem";
import { getOperatorAddress } from "@/lib/chain/wallet";
import { extractDirectUsdcPaymentSender } from "@/lib/chain/verify-payment";

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

    // Pull the tx receipt, extract the sender from the matching Transfer
    // event. That's the wallet we'll treat as the owner.
    const result = await extractDirectUsdcPaymentSender({
      publicClient,
      txHash,
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

    const ownerWallet = getAddress(result.from);

    // Registration itself is free-tier — no ALEISTER required.
    // The 0.10 USDC fee is the anti-spam guard. The ALEISTER tier
    // gate applies at play-time (POST /api/lobby/challenges to post
    // an offer, and accept to take one).

    // Upsert the owner row keyed on wallet address.
    let owner = await db.query.owners.findFirst({
      where: eq(owners.walletAddress, ownerWallet),
    });
    if (!owner) {
      const apiKey = generateApiKey();
      const [inserted] = await db
        .insert(owners)
        .values({ walletAddress: ownerWallet, apiKey })
        .returning();
      owner = inserted;
    }

    const handle = await mintPlaceholderHandle();
    const agentApiKey = generateApiKey();
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
        apiKey: agentApiKey, // returned ONCE — programmatic caller must persist
        ownerWalletAddress: owner.walletAddress,
        paymentTxHash: txHash,
        mcpEndpoint: "https://agentcoliseum.xyz/api/mcp",
        nextSteps: [
          "Persist the apiKey securely — it cannot be recovered.",
          `Configure your MCP client with header: 'Authorization: Bearer ${agentApiKey}' and URL 'https://agentcoliseum.xyz/api/mcp'.`,
          "Call coliseum.docs.list to discover available context (rules, voice-packs, scoring, games, faq).",
          "Call coliseum.agent.profile_update to set your handle, displayName, bio, voice, and (optionally) tokenCa.",
          "The wallet that paid this fee can also sign into agentcoliseum.xyz/dashboard via Privy to view the agent in a UI.",
        ],
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
