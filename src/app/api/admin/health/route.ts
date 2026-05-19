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
// `tournaments` and `treasuryFlows` are referenced in queries below; keep
// the import even if some now-removed read paths used them.
import { erc20Abi } from "viem";
import { db, sql as sqlClient } from "@/lib/db/client";
import {
  agents,
  challenges,
  cronRuns,
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
      cronRunRows,
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
      // Real cron audit log — last 50 runs sorted newest first.
      // Replaces the previous "infer from latest side-effect" heuristic
      // since Sprint 19's recordCronRun() writes a row per tick.
      db
        .select()
        .from(cronRuns)
        .orderBy(desc(cronRuns.startedAt))
        .limit(50),
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
      // Real cron audit — recordCronRun() inserts one row per tick.
      // Per-cron rollup (last run summary) for the KPI strip + the
      // full last-50 timeline for the timeline view.
      cronRuns: cronRunRows.map((r) => ({
        id: r.id,
        name: r.name,
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
        ok: r.ok,
        error: r.error,
        itemsProcessed: r.itemsProcessed,
        durationMs: r.durationMs,
        metadata: r.metadata,
      })),
      cronSummary: summarizeCronRuns(cronRunRows),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Per-cron rollup: latest run + simple ok/fail counts over the last
 * 50 rows. The page colors each cron green/amber/red based on this.
 */
function summarizeCronRuns(rows: Array<typeof cronRuns.$inferSelect>) {
  const byName = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byName.get(r.name) ?? [];
    list.push(r);
    byName.set(r.name, list);
  }
  const out: Record<
    string,
    {
      lastStartedAt: string | null;
      lastCompletedAt: string | null;
      lastOk: boolean | null;
      lastDurationMs: number | null;
      lastError: string | null;
      lastItemsProcessed: number;
      okCount: number;
      failCount: number;
      observedRuns: number;
    }
  > = {};
  for (const [name, list] of byName) {
    const latest = list[0]!;
    let okCount = 0;
    let failCount = 0;
    for (const r of list) {
      if (r.ok === true) okCount++;
      else if (r.ok === false) failCount++;
    }
    out[name] = {
      lastStartedAt: latest.startedAt.toISOString(),
      lastCompletedAt: latest.completedAt?.toISOString() ?? null,
      lastOk: latest.ok,
      lastDurationMs: latest.durationMs,
      lastError: latest.error,
      lastItemsProcessed: latest.itemsProcessed,
      okCount,
      failCount,
      observedRuns: list.length,
    };
  }
  return out;
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
