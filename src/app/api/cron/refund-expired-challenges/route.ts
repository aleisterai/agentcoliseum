/**
 * GET /api/cron/refund-expired-challenges
 *
 * Refunds the proposer's stake on challenges that expired without being
 * accepted. Runs every minute (vercel.json). Mirrors the settlement-sweep
 * cron pattern: bounded batch, idempotent (`proposer_stake_refund_tx_hash
 * IS NULL`), best-effort on individual failures.
 *
 * Selection criteria:
 *   - status = 'posted'
 *   - mode   = 'paid'
 *   - proposer_stake_tx_hash IS NOT NULL  (i.e. we actually pulled stake)
 *   - proposer_stake_refund_tx_hash IS NULL  (idempotency)
 *   - expires_at < now  (challenge has actually timed out)
 *
 * For each:
 *   1. refundStake(ownerWallet, stake) → USDC.transfer operator → owner
 *   2. Update challenge: refund tx hash + status='abandoned' + expiredAt
 */
import { NextResponse } from "next/server";
import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, challenges, owners } from "@/lib/db/schema";
import { refundStake } from "@/lib/chain/stake";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_LIMIT = 10;

function authorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true; // dev mode
  if (req.headers.get("x-vercel-cron-signature")) return true;
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) return jsonError(401, "unauthorized", "Cron secret required");

  const now = new Date();
  const candidates = await db
    .select({
      id: challenges.id,
      stakeUsdc: challenges.stakeUsdc,
      initiatorAgentId: challenges.initiatorAgentId,
      proposerStakeTxHash: challenges.proposerStakeTxHash,
    })
    .from(challenges)
    .where(
      and(
        eq(challenges.status, "posted"),
        eq(challenges.mode, "paid"),
        isNotNull(challenges.proposerStakeTxHash),
        isNull(challenges.proposerStakeRefundTxHash),
        lt(challenges.expiresAt, now),
      ),
    )
    .limit(BATCH_LIMIT);

  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, refunded: 0, message: "no expired challenges" });
  }

  if (!process.env.PLATFORM_OPERATOR_PRIVATE_KEY) {
    return NextResponse.json(
      {
        ok: false,
        message:
          "PLATFORM_OPERATOR_PRIVATE_KEY not set; cannot refund. Configure to enable.",
        pendingCount: candidates.length,
      },
      { status: 503 },
    );
  }

  const results: Array<{
    challengeId: string;
    outcome: "refunded" | "skipped" | "error";
    txHash?: string;
    detail?: string;
  }> = [];

  for (const c of candidates) {
    try {
      if (!c.stakeUsdc) {
        results.push({ challengeId: c.id, outcome: "skipped", detail: "no stake recorded" });
        continue;
      }
      // Look up the initiator's owner wallet — that's where the refund
      // returns. (Phase 1 v2 would target the agent's own wallet once
      // smart-account-per-agent ships.)
      const ownerRow = await db
        .select({ wallet: owners.walletAddress })
        .from(agents)
        .innerJoin(owners, eq(agents.ownerId, owners.id))
        .where(eq(agents.id, c.initiatorAgentId))
        .limit(1);
      const wallet = ownerRow[0]?.wallet;
      if (!wallet) {
        results.push({
          challengeId: c.id,
          outcome: "skipped",
          detail: "no owner wallet for initiator agent",
        });
        continue;
      }

      const refundTxHash = await refundStake(wallet as `0x${string}`, c.stakeUsdc);
      await db
        .update(challenges)
        .set({
          status: "abandoned",
          proposerStakeRefundTxHash: refundTxHash,
        })
        .where(eq(challenges.id, c.id));

      results.push({
        challengeId: c.id,
        outcome: "refunded",
        txHash: refundTxHash,
      });
    } catch (err) {
      console.error(`[cron/refund-expired-challenges] ${c.id} failed`, err);
      results.push({
        challengeId: c.id,
        outcome: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    refunded: results.filter((r) => r.outcome === "refunded").length,
    results,
  });
}
