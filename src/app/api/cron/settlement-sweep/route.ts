/**
 * GET /api/cron/settlement-sweep   (runs every minute via vercel.json)
 *
 * Settles paid matches that have completed but not yet paid out the winner.
 * The 5% treasury fee is already handled by the existing treasury-swap cron
 * (it picks up the `treasury_flows` row inserted by `finalizeMatch`). This
 * cron handles the 95% winner cut: looks up the winner agent's owner wallet
 * and transfers USDC on-chain from the operator wallet.
 *
 * Day 1 scope: skeleton + correct match selection + tx + write `payoutTxHash`
 * and `payoutAt`. In Phase 1 this swaps over to `escrow.resolve` once
 * `MatchEscrow.sol` ships (the cron stays as a fallback for non-escrowed
 * legacy matches).
 *
 * Auth: same pattern as treasury-swap — Vercel cron signature OR Bearer
 * `${CRON_SECRET}`. Dev (no CRON_SECRET) accepts any caller.
 *
 * Safety:
 *   - Bounded batch size (10 per tick) — keeps us under Vercel's per-invocation
 *     timeout and limits blast radius on a misconfigured wallet.
 *   - Idempotency — we re-select on `payoutAt IS NULL` so a partial batch
 *     re-runs cleanly next tick.
 *   - If the operator wallet isn't configured (dev), we return early with a
 *     diagnostic instead of crashing.
 */
import { NextResponse } from "next/server";
import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { db } from "@/lib/db/client";
import { agents, matches, owners } from "@/lib/db/schema";
import { getOperatorWallet } from "@/lib/chain/wallet";
import { publicClient } from "@/lib/chain/viem";
import { USDC_BASE } from "@/lib/chain/aerodrome";
import { payoutSplit } from "@/lib/game/lifecycle";
import { jsonError } from "@/lib/http";
import { recordCronRun } from "@/lib/cron-audit";
import { submitOperatorTx } from "@/lib/chain/operator-nonce";
import { authorizedCronRequest } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_LIMIT = 10;

type PendingMatch = {
  id: string;
  potUsdc: number | null;
  stakeUsdc: number | null;
  winnerAgentId: string | null;
  resultReason: string | null;
};

export async function GET(req: Request) {
  if (!authorizedCronRequest(req))
    return jsonError(401, "unauthorized", "Cron secret required");
  return recordCronRun("settlement-sweep", async ({ setItems, setMetadata }) => {
    return handleSettlementSweep({ setItems, setMetadata });
  });
}

async function handleSettlementSweep({
  setItems,
  setMetadata,
}: {
  setItems: (n: number) => void;
  setMetadata: (m: Record<string, unknown>) => void;
}) {
  // Match selection: completed, paid mode, has a recorded winner (or a draw),
  // and not yet paid out. We deliberately scope this cron to `paid` matches
  // only — free / system matches don't owe USDC.
  const pending = (await db
    .select({
      id: matches.id,
      potUsdc: matches.potUsdc,
      stakeUsdc: matches.stakeUsdc,
      winnerAgentId: matches.winnerAgentId,
      resultReason: matches.resultReason,
    })
    .from(matches)
    .where(
      and(
        eq(matches.status, "completed"),
        eq(matches.mode, "paid"),
        isNull(matches.payoutAt),
        isNotNull(matches.potUsdc),
      ),
    )
    .limit(BATCH_LIMIT)) as PendingMatch[];

  if (pending.length === 0) {
    return NextResponse.json({ ok: true, swept: 0, message: "no pending payouts" });
  }

  // Bail out early if the operator wallet isn't configured. Better to surface
  // the misconfig than to silently mark matches paid with a placeholder.
  if (!process.env.PLATFORM_OPERATOR_PRIVATE_KEY) {
    return NextResponse.json(
      {
        ok: false,
        message:
          "PLATFORM_OPERATOR_PRIVATE_KEY not set; cannot send winner payouts. Configure to enable.",
        pendingCount: pending.length,
      },
      { status: 503 },
    );
  }

  const wallet = getOperatorWallet();
  const results: Array<{
    matchId: string;
    outcome: "paid" | "skipped" | "error";
    txHash?: string;
    detail?: string;
  }> = [];

  for (const m of pending) {
    try {
      if (!m.potUsdc) {
        results.push({ matchId: m.id, outcome: "skipped", detail: "no pot recorded" });
        continue;
      }

      const isDraw = m.resultReason === "draw" || !m.winnerAgentId;
      const split = payoutSplit({
        potUsdc: m.potUsdc,
        isDraw,
        stakeUsdc: m.stakeUsdc ?? 0,
      });

      const transfers = await resolveTransfers(m, isDraw, split);
      if (transfers.length === 0) {
        results.push({
          matchId: m.id,
          outcome: "skipped",
          detail: "no resolvable recipient wallet",
        });
        continue;
      }

      const sentHashes: Hex[] = [];
      for (const t of transfers) {
        // Serialize via the operator-nonce manager so concurrent crons
        // (settlement-sweep + refund + tournament prize payouts) can't
        // collide on the same nonce.
        const hash = await submitOperatorTx((nonce) =>
          wallet.sendTransaction({
            to: USDC_BASE,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [t.to, BigInt(t.amountUsdc)],
            }),
            nonce,
          }),
        );
        await publicClient.waitForTransactionReceipt({ hash });
        sentHashes.push(hash);
      }

      await db
        .update(matches)
        .set({
          payoutAt: new Date(),
          // We record the first tx hash for single-recipient flows (the common
          // case — a clean winner). For draw refunds (two recipients), we
          // concatenate; the human dashboard will split this for display.
          payoutTxHash: sentHashes.join(","),
        })
        .where(eq(matches.id, m.id));

      results.push({
        matchId: m.id,
        outcome: "paid",
        txHash: sentHashes.join(","),
      });
    } catch (err) {
      console.error(`[cron/settlement-sweep] ${m.id} failed`, err);
      results.push({
        matchId: m.id,
        outcome: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const swept = results.filter((r) => r.outcome === "paid").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  const errored = results.filter((r) => r.outcome === "error").length;
  setItems(swept);
  setMetadata({ swept, skipped, errored, batchSize: results.length });
  return NextResponse.json({
    ok: true,
    swept,
    results,
  });
}

/**
 * Resolve the on-chain recipient(s) for a given match. v1 pays out to the
 * winner agent's *owner* wallet (since agents don't yet have their own
 * on-chain wallets — that lands in Phase 1). Draws refund both sides.
 */
async function resolveTransfers(
  m: PendingMatch,
  isDraw: boolean,
  split: ReturnType<typeof payoutSplit>,
): Promise<Array<{ to: `0x${string}`; amountUsdc: number }>> {
  if (isDraw) {
    // Option A: full refund on draw — no platform fee, each side gets
    // their exact stake back. payoutSplit returns refundEach=stakeUsdc.
    // The <= 0 guard stays as defence-in-depth (e.g. someone hand-edits
    // a future free-mode match to status=completed,resultReason=draw,
    // stakeUsdc=0 → resolveTransfers would otherwise try a 0-value
    // transfer and waste a tx).
    const refundEach = split.refundEach ?? 0;
    if (refundEach <= 0) return [];
    const p1 = await loadPlayerWallet(m.id, "p1");
    const p2 = await loadPlayerWallet(m.id, "p2");
    const out: Array<{ to: `0x${string}`; amountUsdc: number }> = [];
    if (p1) out.push({ to: p1, amountUsdc: refundEach });
    if (p2) out.push({ to: p2, amountUsdc: refundEach });
    return out;
  }
  if (!m.winnerAgentId || split.winnerCut <= 0) return [];
  const winner = await loadOwnerWalletByAgent(m.winnerAgentId);
  if (!winner) return [];
  return [{ to: winner, amountUsdc: split.winnerCut }];
}

async function loadOwnerWalletByAgent(agentId: string): Promise<`0x${string}` | null> {
  const row = await db
    .select({ wallet: owners.walletAddress })
    .from(agents)
    .innerJoin(owners, eq(agents.ownerId, owners.id))
    .where(eq(agents.id, agentId))
    .limit(1);
  const addr = row[0]?.wallet;
  return addr ? (addr as `0x${string}`) : null;
}

async function loadPlayerWallet(
  matchId: string,
  side: "p1" | "p2",
): Promise<`0x${string}` | null> {
  const sideCol = side === "p1" ? matches.p1AgentId : matches.p2AgentId;
  const row = await db
    .select({ agentId: sideCol })
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1);
  const agentId = row[0]?.agentId;
  if (!agentId) return null;
  return loadOwnerWalletByAgent(agentId);
}

