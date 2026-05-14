/**
 * GET /api/cron/treasury-swap   (runs every 15 min via vercel.json)
 *
 * Picks up pending treasury_flows rows, batches them by total fee, swaps the
 * USDC to ALEISTER on Aerodrome, and forwards the ALEISTER to the treasury
 * wallet. On success the rows transition pending → swapped → sent. On failure
 * the rows stay pending and the cron retries next sweep.
 *
 * Auth: protected by Vercel's automatic `x-vercel-cron-signature` header, or
 * by an explicit `Authorization: Bearer ${CRON_SECRET}` header if you call it
 * manually. In dev (no Vercel header) we accept any request — set CRON_SECRET
 * for prod-equivalent gating.
 */
import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { treasuryFlows } from "@/lib/db/schema";
import { swapUsdcToAleister, sendAleisterToTreasury } from "@/lib/chain/aerodrome";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // seconds

function authorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true; // dev mode
  const vercelSig = req.headers.get("x-vercel-cron-signature");
  if (vercelSig) return true;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${cronSecret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) return jsonError(401, "unauthorized", "Cron secret required");

  // Pick up to 25 pending rows per sweep. Larger batches mean fewer swaps
  // (better gas) but bigger blast radius on a failure.
  const pending = await db
    .select()
    .from(treasuryFlows)
    .where(eq(treasuryFlows.status, "pending"))
    .limit(25);

  if (pending.length === 0) {
    return NextResponse.json({ ok: true, swept: 0, message: "no pending flows" });
  }

  const totalUsdcUnits = pending.reduce((sum, r) => sum + r.feeUsdc, 0);
  const totalUsdcBigInt = BigInt(totalUsdcUnits);
  const flowIds = pending.map((r) => r.id);

  let swapTxHash: string | undefined;
  let treasuryTxHash: string | undefined;
  let aleisterOut: bigint | undefined;

  try {
    const swap = await swapUsdcToAleister(totalUsdcBigInt);
    swapTxHash = swap.swapTxHash;
    aleisterOut = swap.aleisterOut;

    // Mark swapped
    await db
      .update(treasuryFlows)
      .set({
        status: "swapped",
        aleisterOut: aleisterOut.toString(),
        swapTxHash,
        swappedAt: new Date(),
      })
      .where(inArray(treasuryFlows.id, flowIds));

    // Send to treasury wallet
    treasuryTxHash = await sendAleisterToTreasury(aleisterOut);

    await db
      .update(treasuryFlows)
      .set({
        status: "sent",
        treasuryTxHash,
        sentAt: new Date(),
      })
      .where(inArray(treasuryFlows.id, flowIds));

    return NextResponse.json({
      ok: true,
      swept: pending.length,
      totalUsdcUnits,
      aleisterOut: aleisterOut.toString(),
      swapTxHash,
      treasuryTxHash,
    });
  } catch (err) {
    console.error("[cron/treasury-swap] failed", err);
    await db
      .update(treasuryFlows)
      .set({
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      .where(inArray(treasuryFlows.id, flowIds));
    return NextResponse.json(
      {
        ok: false,
        message: "swap or transfer failed; rows remain pending for retry",
        swapTxHash,
        treasuryTxHash,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
