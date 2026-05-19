/**
 * GET /api/admin/health — operator-only deep diagnostic.
 *
 * Returns everything /api/health does, PLUS:
 *   - pool stats from postgres-js (active, idle, waiting)
 *   - operator wallet balances (USDC + ETH on Base)
 *   - pending work counts (queued payouts, refunds, active matches,
 *     running tournaments)
 *   - cron freshness markers — last completed timestamps for the
 *     four crons, derived from the latest rows each one would have
 *     touched
 *   - DB size + table-row counts on the hot tables
 *
 * Used by /admin/health page. Operator-gated via OPERATOR_WALLETS env.
 */
import { NextResponse } from "next/server";
import { and, count, desc, eq, isNotNull, isNull, lt, sql as drizzleSql } from "drizzle-orm";
import { erc20Abi } from "viem";
import { db, sql as sqlClient } from "@/lib/db/client";
import {
  agents,
  challenges,
  matches,
  tournaments,
  treasuryFlows,
} from "@/lib/db/schema";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { isOperatorWallet } from "@/lib/auth/operator";
import { errorResponse } from "@/lib/http";
import { publicClient } from "@/lib/chain/viem";
import { USDC_BASE } from "@/lib/chain/aerodrome";
import { getOperatorAddress } from "@/lib/chain/wallet";

export const dynamic = "force-dynamic";

interface PostgresJsClientShape {
  totalCount?: number;
  idleCount?: number;
  reservedCount?: number;
  waiting?: number;
}

function poolStats() {
  // postgres-js exposes these on the client instance (not officially
  // documented but stable). Wrap defensively in case it changes.
  try {
    const c = sqlClient as unknown as PostgresJsClientShape;
    return {
      total: c.totalCount ?? null,
      idle: c.idleCount ?? null,
      reserved: c.reservedCount ?? null,
      waiting: c.waiting ?? null,
    };
  } catch {
    return { total: null, idle: null, reserved: null, waiting: null };
  }
}

export async function GET(req: Request) {
  try {
    const wallet = await resolvePrivyWallet(req);
    if (!wallet) throw new UnauthorizedError("unauthorized", "Privy session required");
    if (!isOperatorWallet(wallet)) {
      throw new UnauthorizedError("forbidden", "Operator wallet only");
    }

    const now = new Date();
    const operator = getOperatorAddress();

    const [
      dbProbe,
      latestSettlement,
      latestRefund,
      latestTournamentTick,
      latestTimeout,
      pendingPayouts,
      pendingRefunds,
      activeMatchCount,
      runningTournaments,
      openChallengeCount,
      agentsTotal,
      matchesTotal,
      matchesActive,
      treasuryFlowsCount,
      dbSizeRow,
      usdcBalance,
      ethBalance,
    ] = await Promise.all([
      probe(() => db.execute(drizzleSql`SELECT 1`)),
      db
        .select({ at: matches.payoutAt })
        .from(matches)
        .where(isNotNull(matches.payoutAt))
        .orderBy(desc(matches.payoutAt))
        .limit(1),
      db
        .select({ at: challenges.postedAt })
        .from(challenges)
        .where(isNotNull(challenges.proposerStakeRefundTxHash))
        .orderBy(desc(challenges.postedAt))
        .limit(1),
      db
        .select({ at: tournaments.completedAt })
        .from(tournaments)
        .where(isNotNull(tournaments.completedAt))
        .orderBy(desc(tournaments.completedAt))
        .limit(1),
      db
        .select({ at: matches.abandonedAt })
        .from(matches)
        .where(isNotNull(matches.abandonedAt))
        .orderBy(desc(matches.abandonedAt))
        .limit(1),
      db
        .select({ c: count() })
        .from(matches)
        .where(
          and(
            eq(matches.status, "completed"),
            eq(matches.mode, "paid"),
            isNull(matches.payoutAt),
            isNotNull(matches.potUsdc),
          ),
        ),
      db
        .select({ c: count() })
        .from(challenges)
        .where(
          and(
            eq(challenges.status, "posted"),
            eq(challenges.mode, "paid"),
            isNotNull(challenges.proposerStakeTxHash),
            isNull(challenges.proposerStakeRefundTxHash),
            lt(challenges.expiresAt, now),
          ),
        ),
      db.select({ c: count() }).from(matches).where(eq(matches.status, "active")),
      db
        .select({ c: count() })
        .from(tournaments)
        .where(eq(tournaments.status, "running")),
      db.select({ c: count() }).from(challenges).where(eq(challenges.status, "posted")),
      db.select({ c: count() }).from(agents),
      db.select({ c: count() }).from(matches),
      db.select({ c: count() }).from(matches).where(eq(matches.status, "active")),
      db.select({ c: count() }).from(treasuryFlows),
      db.execute(drizzleSql`SELECT pg_database_size(current_database()) AS bytes`),
      publicClient
        .readContract({
          address: USDC_BASE,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [operator],
        })
        .catch(() => 0n),
      publicClient.getBalance({ address: operator }).catch(() => 0n),
    ]);

    const dbSizeBytes = Number(
      (dbSizeRow as unknown as Array<{ bytes: string | number }>)[0]?.bytes ?? 0,
    );

    return NextResponse.json({
      timestamp: now.toISOString(),
      operator: {
        address: operator,
        usdcBalanceMicro: Number(
          usdcBalance > BigInt(Number.MAX_SAFE_INTEGER)
            ? BigInt(Number.MAX_SAFE_INTEGER)
            : usdcBalance,
        ),
        ethBalanceWei: ethBalance.toString(),
      },
      db: {
        ok: dbProbe.ok,
        probeLatencyMs: dbProbe.latencyMs,
        pool: poolStats(),
        sizeBytes: dbSizeBytes,
      },
      pending: {
        payouts: pendingPayouts[0]?.c ?? 0,
        refunds: pendingRefunds[0]?.c ?? 0,
        activeMatches: activeMatchCount[0]?.c ?? 0,
        runningTournaments: runningTournaments[0]?.c ?? 0,
        openChallenges: openChallengeCount[0]?.c ?? 0,
      },
      totals: {
        agents: agentsTotal[0]?.c ?? 0,
        matches: matchesTotal[0]?.c ?? 0,
        matchesActive: matchesActive[0]?.c ?? 0,
        treasuryFlows: treasuryFlowsCount[0]?.c ?? 0,
      },
      cronFreshness: {
        // We can't directly observe cron last-run timestamps without an
        // audit log, so we infer from the latest rows each cron would
        // have touched. If these go stale, the cron is dead.
        settlementSweep_lastSuccessAt:
          latestSettlement[0]?.at?.toISOString() ?? null,
        refundExpired_lastSuccessAt:
          latestRefund[0]?.at?.toISOString() ?? null,
        tournamentProgression_lastSuccessAt:
          latestTournamentTick[0]?.at?.toISOString() ?? null,
        timeoutGames_lastSuccessAt: latestTimeout[0]?.at?.toISOString() ?? null,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

async function probe(fn: () => Promise<unknown>): Promise<{ ok: boolean; latencyMs?: number; detail?: string }> {
  const start = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
