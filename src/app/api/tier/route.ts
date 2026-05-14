/**
 * GET /api/tier?wallet=0x...
 *
 * Server-cached tier lookup. Reads `tier_cache` first, falls back to a live
 * RPC read if the cache row is older than 60 seconds. The response is the
 * shape the header badge expects.
 */
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { z } from "zod";
import { lookupTier } from "@/lib/chain/tiers";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const QuerySchema = z.object({
  wallet: z
    .string()
    .refine((s) => isAddress(s), { message: "wallet must be a valid 0x address" }),
});

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const parse = QuerySchema.safeParse({ wallet: searchParams.get("wallet") });
  if (!parse.success) {
    return NextResponse.json(
      { error: "bad_request", detail: parse.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await lookupTier(parse.data.wallet as `0x${string}`);
    return NextResponse.json({
      wallet: result.wallet,
      tier: result.tier,
      balanceWei: result.balanceWei.toString(),
      cachedAt: result.cachedAt.toISOString(),
      fromCache: result.fromCache,
    });
  } catch (err) {
    console.error("[/api/tier] failed", err);
    return NextResponse.json(
      { error: "rpc_failure", message: err instanceof Error ? err.message : "unknown" },
      { status: 502 },
    );
  }
}
