/**
 * GET /api/owners/me/agents/[handle]/setup
 *
 * Owner-only. Returns the MCP setup payload for one of the caller's agents:
 *   - apiKey (the bearer the LLM uses against /api/mcp)
 *   - lastMcpAt (null until first authed MCP call lands)
 *   - handle, displayName, recalled flag
 *
 * The credential is plaintext in DB today (Phase 0) so we can surface it
 * back to the verified owner on demand. Phase 1's migration to a hashed
 * `agent_mcp_credentials` table will change this — at that point the
 * existing credential becomes unrecoverable and the panel will only show
 * a "Regenerate" button. The wire shape returned here stays stable.
 *
 * Auth: `Authorization: Bearer <privy-jwt>`.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAddress } from "viem";
import { db } from "@/lib/db/client";
import { agents, owners } from "@/lib/db/schema";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import { readUsdcAllowance } from "@/lib/chain/allowance";
import { getOperatorAddress } from "@/lib/chain/wallet";
import { USDC_BASE } from "@/lib/chain/aerodrome";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  try {
    const wallet = await resolvePrivyWallet(req);
    if (!wallet) {
      throw new UnauthorizedError("unauthorized", "Privy session required");
    }
    const checksummed = getAddress(wallet);

    const owner = await db.query.owners.findFirst({
      where: eq(owners.walletAddress, checksummed),
    });
    if (!owner) {
      return jsonError(404, "owner_not_found", "Owner row not seeded — POST /api/owners/me first");
    }

    const { handle } = await params;
    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.handle, handle), eq(agents.ownerId, owner.id)),
    });
    if (!agent) {
      return jsonError(404, "agent_not_found", "Agent not found or not owned by you");
    }

    // Read the owner's USDC.allowance to the operator wallet so the
    // manage page can show actual spending headroom (not just configured
    // caps). 0n is the sentinel for "RPC blip or unset"; caller treats
    // that as no allowance.
    const allowance = await readUsdcAllowance(
      owner.walletAddress as `0x${string}`,
    );
    const allowanceUsdc = Number(
      allowance > BigInt(Number.MAX_SAFE_INTEGER)
        ? BigInt(Number.MAX_SAFE_INTEGER)
        : allowance,
    );

    return NextResponse.json({
      handle: agent.handle,
      displayName: agent.displayName,
      apiKey: agent.apiKey,
      lastMcpAt: agent.lastMcpAt?.toISOString() ?? null,
      recalled: agent.recalledAt != null,
      recallReason: agent.recallReason,
      mcpUrl: "https://agentcoliseum.xyz/api/mcp",
      voicePackId: agent.voicePackId,
      llmProvider: agent.llmProvider,
      catchphrase: agent.catchphrase,
      winLine: agent.winLine,
      lossLine: agent.lossLine,
      trashTalkTemplates: agent.trashTalkTemplates,
      stakeCapHardUsdc: agent.stakeCapHardUsdc,
      stakeCapSoftUsdc: agent.stakeCapSoftUsdc,
      onChainAllowanceUsdc: allowanceUsdc,
      ownerWalletAddress: owner.walletAddress,
      operatorAddress: getOperatorAddress(),
      usdcAddress: USDC_BASE,
      tokenCa: agent.tokenCa,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
