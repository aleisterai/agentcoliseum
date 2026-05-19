/**
 * GET /api/admin/treasury — operator-only treasury dashboard data.
 *
 * Returns:
 *   operator wallet (USDC + ETH balance, on-chain links)
 *   pending payouts: matches where status='completed', payoutAt IS NULL,
 *                    paid mode (the settlement-sweep cron's queue)
 *   pending refunds: paid challenges with proposer_stake_tx_hash but
 *                    expired without acceptance + no refund yet
 *   treasury_flows: last 50 (incl. swap/treasury tx hashes)
 *
 * Operator gates via OPERATOR_WALLETS env.
 */
import { NextResponse } from "next/server";
import { and, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { erc20Abi } from "viem";
import { db } from "@/lib/db/client";
import { challenges, matches, treasuryFlows } from "@/lib/db/schema";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { isOperatorWallet } from "@/lib/auth/operator";
import { errorResponse } from "@/lib/http";
import { publicClient } from "@/lib/chain/viem";
import { USDC_BASE } from "@/lib/chain/aerodrome";
import { getOperatorAddress } from "@/lib/chain/wallet";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const wallet = await resolvePrivyWallet(req);
    if (!wallet) throw new UnauthorizedError("unauthorized", "Privy session required");
    if (!isOperatorWallet(wallet)) {
      throw new UnauthorizedError("forbidden", "Operator wallet only");
    }

    const operator = getOperatorAddress();
    const now = new Date();

    const [usdcBalance, ethBalance, pendingPayouts, pendingRefunds, recentFlows] =
      await Promise.all([
        publicClient
          .readContract({
            address: USDC_BASE,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [operator],
          })
          .catch(() => 0n),
        publicClient.getBalance({ address: operator }).catch(() => 0n),
        db
          .select({
            id: matches.id,
            gameType: matches.gameType,
            potUsdc: matches.potUsdc,
            winnerAgentId: matches.winnerAgentId,
            completedAt: matches.completedAt,
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
          .orderBy(desc(matches.completedAt))
          .limit(20),
        db
          .select({
            id: challenges.id,
            gameType: challenges.gameType,
            stakeUsdc: challenges.stakeUsdc,
            proposerStakeTxHash: challenges.proposerStakeTxHash,
            expiresAt: challenges.expiresAt,
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
          .limit(20),
        db
          .select()
          .from(treasuryFlows)
          .orderBy(desc(treasuryFlows.createdAt))
          .limit(50),
      ]);

    const pendingLiabilityUsdc =
      pendingPayouts.reduce((acc, m) => acc + (m.potUsdc ?? 0), 0) +
      pendingRefunds.reduce((acc, c) => acc + (c.stakeUsdc ?? 0), 0);

    return NextResponse.json({
      operatorAddress: operator,
      usdcBalanceMicro: Number(
        usdcBalance > BigInt(Number.MAX_SAFE_INTEGER)
          ? BigInt(Number.MAX_SAFE_INTEGER)
          : usdcBalance,
      ),
      ethBalanceWei: ethBalance.toString(),
      basescanUrl: `https://basescan.org/address/${operator}`,
      pendingPayouts: pendingPayouts.map((m) => ({
        id: m.id,
        gameType: m.gameType,
        potUsdc: m.potUsdc,
        winnerAgentId: m.winnerAgentId,
        completedAt: m.completedAt?.toISOString() ?? null,
      })),
      pendingRefunds: pendingRefunds.map((c) => ({
        id: c.id,
        gameType: c.gameType,
        stakeUsdc: c.stakeUsdc,
        proposerStakeTxHash: c.proposerStakeTxHash,
        expiresAt: c.expiresAt?.toISOString() ?? null,
      })),
      pendingLiabilityUsdc,
      treasuryFlows: recentFlows.map((f) => ({
        id: f.id,
        matchId: f.matchId,
        feeUsdc: f.feeUsdc,
        status: f.status,
        aleisterOut: f.aleisterOut,
        swapTxHash: f.swapTxHash,
        treasuryTxHash: f.treasuryTxHash,
        createdAt: f.createdAt.toISOString(),
        sentAt: f.sentAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/admin/treasury — force-trigger one of the maintenance crons.
 * Body: { action: "settlement-sweep" | "refund-expired-challenges" }
 *
 * Forwards to the same handler the cron schedule hits, using a CRON_SECRET
 * bearer. Operator-only; returns whatever the cron returned.
 */
export async function POST(req: Request) {
  try {
    const wallet = await resolvePrivyWallet(req);
    if (!wallet) throw new UnauthorizedError("unauthorized", "Privy session required");
    if (!isOperatorWallet(wallet)) {
      throw new UnauthorizedError("forbidden", "Operator wallet only");
    }
    const { action } = (await req.json()) as { action?: string };
    if (action !== "settlement-sweep" && action !== "refund-expired-challenges") {
      return NextResponse.json(
        { error: "bad_action", message: "action must be settlement-sweep or refund-expired-challenges" },
        { status: 400 },
      );
    }
    const url = new URL(req.url);
    const cronUrl = `${url.origin}/api/cron/${action}`;
    const cronSecret = process.env.CRON_SECRET;
    const headers: Record<string, string> = {};
    if (cronSecret) headers.Authorization = `Bearer ${cronSecret}`;
    const res = await fetch(cronUrl, { headers });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json({ status: res.status, body });
  } catch (err) {
    return errorResponse(err);
  }
}
