/**
 * GET /api/cron/settlement-sweep   (runs every minute via vercel.json)
 *
 * Drains pending rows from `match_payouts` by submitting one USDC
 * transfer per row from the operator wallet. Each row's tx_hash +
 * status is updated independently, so a Vercel timeout mid-batch
 * leaves the still-pending rows for the next tick — never a
 * double-send.
 *
 * **What changed (2026-05):** before the `match_payouts` table, this
 * cron resolved transfers from `matches` columns (winnerAgentId,
 * resultReason, potUsdc) and used a SINGLE `matches.payoutAt` marker.
 * A crash after one side of a draw refund left the other side
 * unprotected — re-run double-paid the first recipient. Now the unit
 * of work is the payout row, not the match.
 *
 * **Lifecycle of a payout row:**
 *   1. `finalizeMatchTx` inserts pending row (UNIQUE constraint on
 *      (matchId, recipientAddress, payoutReason) prevents dupes)
 *   2. This cron picks pending → submitOperatorTx → marks `submitted`
 *      with tx_hash + submitted_at
 *   3. After `waitForTransactionReceipt`, marks `confirmed` with
 *      `confirmed_at`. Receipt rejection → `failed` with last_error
 *   4. Manual operator can re-queue a `failed` row by re-setting it
 *      to `pending` (TODO admin UI)
 *
 * **`submitted` rows after a crash:** if the process dies between
 * submitting the tx and writing the receipt, the row sits in
 * `submitted` with a tx_hash. Next cron tick treats `submitted` like
 * `pending` and re-runs `waitForTransactionReceipt` against the
 * existing tx_hash — NOT a re-submit. Idempotent.
 *
 * Auth: same pattern as treasury-swap — Vercel cron signature OR
 * Bearer `${CRON_SECRET}`. Dev (no CRON_SECRET) accepts any caller.
 */
import { NextResponse } from "next/server";
import { eq, inArray, sql as dsql } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { db } from "@/lib/db/client";
import { matches, matchPayouts } from "@/lib/db/schema";
import { getOperatorWallet } from "@/lib/chain/wallet";
import { publicClient } from "@/lib/chain/viem";
import { USDC_BASE } from "@/lib/chain/aerodrome";
import { jsonError } from "@/lib/http";
import { recordCronRun } from "@/lib/cron-audit";
import { submitOperatorTx } from "@/lib/chain/operator-nonce";
import { authorizedCronRequest } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_LIMIT = 10;

export async function GET(req: Request) {
  if (!authorizedCronRequest(req))
    return jsonError(401, "unauthorized", "Cron secret required");
  return recordCronRun(
    "settlement-sweep",
    async ({ setItems, setMetadata }) => {
      return handleSettlementSweep({ setItems, setMetadata });
    },
  );
}

interface PerRowOutcome {
  payoutId: string;
  matchId: string;
  outcome: "confirmed" | "resumed" | "skipped" | "failed";
  txHash?: string;
  detail?: string;
}

async function handleSettlementSweep({
  setItems,
  setMetadata,
}: {
  setItems: (n: number) => void;
  setMetadata: (m: Record<string, unknown>) => void;
}) {
  // Pick up pending + submitted rows in one batch. `submitted` rows
  // are partial — tx is on-chain, we just didn't get to mark confirmed.
  // The `waitForTransactionReceipt` call on an already-confirmed tx
  // returns instantly without re-broadcasting, so this is safe.
  const pending = await db
    .select()
    .from(matchPayouts)
    .where(inArray(matchPayouts.status, ["pending", "submitted"]))
    .limit(BATCH_LIMIT);

  if (pending.length === 0) {
    setItems(0);
    setMetadata({
      confirmed: 0,
      resumed: 0,
      skipped: 0,
      failed: 0,
      batchSize: 0,
    });
    return NextResponse.json({
      ok: true,
      drained: 0,
      message: "no pending payouts",
    });
  }

  // Operator wallet must be configured to send. Bail early instead of
  // looping and erroring on every row (cleaner audit log entry, fewer
  // false failures on the rows).
  if (!process.env.PLATFORM_OPERATOR_PRIVATE_KEY) {
    setItems(0);
    setMetadata({
      confirmed: 0,
      resumed: 0,
      skipped: pending.length,
      failed: 0,
      reason: "operator wallet not configured",
    });
    return NextResponse.json(
      {
        ok: false,
        message:
          "PLATFORM_OPERATOR_PRIVATE_KEY not set; cannot drain payout queue. Configure to enable.",
        pendingCount: pending.length,
      },
      { status: 503 },
    );
  }

  const wallet = getOperatorWallet();
  const results: PerRowOutcome[] = [];

  for (const row of pending) {
    try {
      // Already-submitted: skip the submit, just chase the receipt.
      if (row.status === "submitted" && row.txHash) {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: row.txHash as Hex,
        });
        if (receipt.status === "success") {
          await db
            .update(matchPayouts)
            .set({ status: "confirmed", confirmedAt: new Date() })
            .where(eq(matchPayouts.id, row.id));
          results.push({
            payoutId: row.id,
            matchId: row.matchId,
            outcome: "resumed",
            txHash: row.txHash,
          });
        } else {
          await db
            .update(matchPayouts)
            .set({
              status: "failed",
              lastError: "receipt status reverted",
              attemptCount: dsql`${matchPayouts.attemptCount} + 1`,
            })
            .where(eq(matchPayouts.id, row.id));
          results.push({
            payoutId: row.id,
            matchId: row.matchId,
            outcome: "failed",
            detail: "receipt reverted",
          });
        }
        continue;
      }

      // Skip 0-amount rows. Defence-in-depth — finalize already
      // refuses to enqueue these, but if a hand-edited row slipped
      // through, no-op rather than wasting a tx.
      if (row.amountUsdc <= 0) {
        await db
          .update(matchPayouts)
          .set({
            status: "failed",
            lastError: "amountUsdc must be > 0",
          })
          .where(eq(matchPayouts.id, row.id));
        results.push({
          payoutId: row.id,
          matchId: row.matchId,
          outcome: "skipped",
          detail: "zero amount",
        });
        continue;
      }

      // Submit the transfer, capture the hash IMMEDIATELY (before
      // waiting for receipt) so a crash mid-wait still leaves the
      // tx_hash on the row for the resume-from-submitted path.
      const hash = await submitOperatorTx((nonce) =>
        wallet.sendTransaction({
          to: USDC_BASE,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [
              row.recipientAddress as `0x${string}`,
              BigInt(row.amountUsdc),
            ],
          }),
          nonce,
        }),
      );
      await db
        .update(matchPayouts)
        .set({
          status: "submitted",
          txHash: hash,
          submittedAt: new Date(),
          attemptCount: dsql`${matchPayouts.attemptCount} + 1`,
        })
        .where(eq(matchPayouts.id, row.id));

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "success") {
        await db
          .update(matchPayouts)
          .set({ status: "confirmed", confirmedAt: new Date() })
          .where(eq(matchPayouts.id, row.id));
        // Also stamp the legacy matches.payoutAt + payoutTxHash for
        // dashboards still reading those columns. Best-effort — if
        // multiple payouts exist for the same match (draw refunds)
        // this writes the LAST one's tx hash, which is acceptable for
        // display purposes since the match_payouts table is the
        // canonical record.
        await db
          .update(matches)
          .set({ payoutAt: new Date(), payoutTxHash: hash })
          .where(eq(matches.id, row.matchId));
        results.push({
          payoutId: row.id,
          matchId: row.matchId,
          outcome: "confirmed",
          txHash: hash,
        });
      } else {
        await db
          .update(matchPayouts)
          .set({
            status: "failed",
            lastError: "receipt status reverted",
          })
          .where(eq(matchPayouts.id, row.id));
        results.push({
          payoutId: row.id,
          matchId: row.matchId,
          outcome: "failed",
          detail: "receipt reverted",
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `[cron/settlement-sweep] payout ${row.id} (match ${row.matchId}) failed`,
        err,
      );
      await db
        .update(matchPayouts)
        .set({
          // Leave it as 'submitted' if we got a tx_hash already, so the
          // next tick resumes from waitForTransactionReceipt. Otherwise
          // back to 'failed' for operator review.
          status: row.txHash ? "submitted" : "failed",
          lastError: detail,
          attemptCount: dsql`${matchPayouts.attemptCount} + 1`,
        })
        .where(eq(matchPayouts.id, row.id));
      results.push({
        payoutId: row.id,
        matchId: row.matchId,
        outcome: "failed",
        detail,
      });
    }
  }

  const confirmed = results.filter((r) => r.outcome === "confirmed").length;
  const resumed = results.filter((r) => r.outcome === "resumed").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  setItems(confirmed + resumed);
  setMetadata({
    confirmed,
    resumed,
    skipped,
    failed,
    batchSize: results.length,
  });
  return NextResponse.json({
    ok: true,
    drained: confirmed + resumed,
    confirmed,
    resumed,
    skipped,
    failed,
    results,
  });
}
