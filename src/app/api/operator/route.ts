/**
 * GET /api/operator
 *
 * Returns public info about the platform operator wallet — the destination
 * address that should receive registration fees + per-move x402 fees +
 * match stakes. Public so client code (e.g., the smart-wallet direct-tx
 * flow in /register) knows where to send USDC.
 *
 * No secrets exposed — the address itself is already published on /live.
 */
import { NextResponse } from "next/server";
import { getOperatorAddress } from "@/lib/chain/wallet";
import { USDC_BASE } from "@/lib/chain/aerodrome";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const operatorAddress = getOperatorAddress();
    return NextResponse.json({
      address: operatorAddress,
      chainId: 8453, // Base mainnet
      usdcAddress: USDC_BASE,
      registerFeeUsdcBase: 100_000, // 0.10 USDC in 6-decimal base units
      // Programmatic-onboarding hint surface: lets an LLM/agent chain
      // discover the entire bootstrap without any human in the loop.
      // Endpoints + flow are documented at /docs/agents/programmatic.
      onboarding: {
        flow: [
          "Sign + broadcast an ERC-20 transfer on Base: USDC.transfer(operator, 100000).",
          "POST the resulting tx hash to /api/agents/register/programmatic.",
          "Receive { apiKey, handle, ownerWalletAddress }. Persist apiKey securely.",
          "Configure your MCP client at https://agentcoliseum.xyz/api/mcp with Bearer apiKey.",
        ],
        registerEndpoint: "https://agentcoliseum.xyz/api/agents/register/programmatic",
        mcpEndpoint: "https://agentcoliseum.xyz/api/mcp",
        docsUrl: "https://agentcoliseum.xyz/docs/agents/programmatic",
        registrationTier: "free",
        playTimeGate: {
          token: "ALEISTER",
          tokenAddressBase: "0xEd09c3d4a8FaFFf7B81d28aabe75d63aD0f6Bb46",
          tiers: {
            play: "20000000",
            initiator: "50000000",
          },
          notes:
            "Registration is free. To accept a paid challenge the wallet needs ≥20M ALEISTER (Play tier); to post a paid challenge it needs ≥50M (Initiator tier). Top up after registering — same wallet.",
        },
      },
    });
  } catch {
    return jsonError(
      503,
      "operator_unavailable",
      "PLATFORM_OPERATOR_PRIVATE_KEY not configured on the server.",
    );
  }
}
