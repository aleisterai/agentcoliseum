/**
 * GET /api/cron/refund-expired-challenges
 *
 * Sweeps challenges that expired without being accepted. Runs every
 * minute (vercel.json). Mirrors the settlement-sweep cron pattern:
 * bounded batch, idempotent, best-effort on individual failures.
 *
 * Two parallel paths in one cron run:
 *
 *   Paid challenges  (mode='paid' + proposer_stake_tx_hash IS NOT NULL):
 *     1. refundStake(ownerWallet, stake) — USDC.transfer operator → owner
 *     2. set proposer_stake_refund_tx_hash + status='abandoned'
 *     Idempotent on `proposer_stake_refund_tx_hash IS NULL`.
 *
 *   Free challenges  (mode='free' + no stake was ever locked):
 *     1. set status='abandoned'  — nothing to refund, just close the row
 *     Otherwise these ghost-row forever and pollute the lobby UI + MCP
 *     match_list (until we added a NOW() filter; even then, having
 *     stale rows around hides the cron failing).
 *
 * System-mode challenges shouldn't appear here at all (they go
 * straight to a match on propose), but we belt-and-braces include
 * them in the free path in case a propose+immediate-failure leaves
 * one stuck.
 *
 * Selection (paid):
 *   status='posted' AND mode='paid' AND proposer_stake_tx_hash IS NOT NULL
 *   AND proposer_stake_refund_tx_hash IS NULL AND expires_at < now
 *
 * Selection (free / system):
 *   status='posted' AND mode IN ('free','system') AND expires_at < now
 */
import { NextResponse } from "next/server";
import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, challenges, owners } from "@/lib/db/schema";
import { refundStake } from "@/lib/chain/stake";
import { jsonError } from "@/lib/http";
import { recordCronRun } from "@/lib/cron-audit";
import { authorizedCronRequest } from "@/lib/cron-auth";
import { broadcastAgent, realtimeEvent } from "@/lib/realtime";
import type { ChallengeExpiredPayload } from "@/lib/realtime-types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_LIMIT = 10;

export async function GET(req: Request) {
  if (!authorizedCronRequest(req))
    return jsonError(401, "unauthorized", "Cron secret required");
  return recordCronRun("refund-expired-challenges", async ({ setItems, setMetadata }) => {
    return handleRefundCron({ setItems, setMetadata });
  });
}

async function handleRefundCron({
  setItems,
  setMetadata,
}: {
  setItems: (n: number) => void;
  setMetadata: (m: Record<string, unknown>) => void;
}) {
  const now = new Date();

  // Pass A — free / system challenges. No on-chain refund needed;
  // just close the row so the lobby + MCP stop surfacing them.
  // Returning UPDATE's affected count would be cleaner if drizzle's
  // postgres-js driver surfaced it; we just do a SELECT-then-UPDATE
  // bound by id so the audit log matches what we touched.
  const freeStale = await db
    .select({ id: challenges.id, mode: challenges.mode, initiatorAgentId: challenges.initiatorAgentId, gameType: challenges.gameType })
    .from(challenges)
    .where(
      and(
        eq(challenges.status, "posted"),
        inArray(challenges.mode, ["free", "system"]),
        lt(challenges.expiresAt, now),
      ),
    )
    .limit(BATCH_LIMIT);
  let freeAbandoned = 0;
  if (freeStale.length > 0) {
    await db
      .update(challenges)
      .set({
        status: "abandoned",
        abandonedAt: now,
        abandonedReason: "expired",
      })
      .where(
        inArray(
          challenges.id,
          freeStale.map((r) => r.id),
        ),
      );
    freeAbandoned = freeStale.length;
    // Wake any match_list(wait:true) the proposer has open so the agent loop
    // can stop waiting for an accept that will never come. Fire-and-forget.
    for (const c of freeStale) {
      void broadcastAgent(c.initiatorAgentId, realtimeEvent.ChallengeExpired, {
        challengeId: c.id,
        gameType: c.gameType,
      } satisfies ChallengeExpiredPayload);
    }
  }

  // Pass B — paid challenges. These need an on-chain refund first.
  const candidates = await db
    .select({
      id: challenges.id,
      gameType: challenges.gameType,
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
    // Even with no paid work, free pass might have closed rows.
    setItems(freeAbandoned);
    setMetadata({ refunded: 0, freeAbandoned, skipped: 0, errored: 0 });
    return NextResponse.json({
      ok: true,
      refunded: 0,
      freeAbandoned,
      message:
        freeAbandoned > 0
          ? `closed ${freeAbandoned} expired free/system challenges`
          : "no expired challenges",
    });
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

      // Wake the proposer's match_list(wait:true) so they know
      // to stop expecting an accept. Fire-and-forget.
      void broadcastAgent(c.initiatorAgentId, realtimeEvent.ChallengeExpired, {
        challengeId: c.id,
        gameType: c.gameType,
      } satisfies ChallengeExpiredPayload);
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

  const refunded = results.filter((r) => r.outcome === "refunded").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  const errored = results.filter((r) => r.outcome === "error").length;
  setItems(refunded + freeAbandoned);
  setMetadata({
    refunded,
    freeAbandoned,
    skipped,
    errored,
    batchSize: results.length,
  });
  return NextResponse.json({
    ok: true,
    refunded,
    freeAbandoned,
    results,
  });
}
