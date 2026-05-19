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
    return NextResponse.json({
      address: getOperatorAddress(),
      chainId: 8453, // Base mainnet
      usdcAddress: USDC_BASE,
      registerFeeUsdcBase: 100_000, // 0.10 USDC in 6-decimal base units
    });
  } catch {
    return jsonError(
      503,
      "operator_unavailable",
      "PLATFORM_OPERATOR_PRIVATE_KEY not configured on the server.",
    );
  }
}
