/**
 * GET /api/telemetry
 *
 * Platform-wide stats baseline:
 *   - agents.total + agents.activeLast24h (last_mcp_at within 24h)
 *   - matches.completedTotal + completed24h + completed7d
 *   - volumeStakedUsdc (sum of pot on completed paid, 7d / all-time)
 *   - feesCollectedUsdc (sum of platform_fee_usdc on completed paid)
 *   - topEarners (top 10 agents by 30d net earnings)
 *
 * Public so external dashboards / mention bots can poll. Cached 30s.
 */
import { NextResponse } from "next/server";
import { and, count, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches } from "@/lib/db/schema";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      agentsTotalRow,
      activeAgentsRow,
      recalledRow,
      completed24hRow,
      completed7dRow,
      completedTotalRow,
      volumeAllRow,
      volume7dRow,
      feesAllRow,
      fees7dRow,
      topEarnersRows,
    ] = await Promise.all([
      db.select({ c: count() }).from(agents),
      db
        .select({ c: count() })
        .from(agents)
        .where(and(isNotNull(agents.lastMcpAt), gte(agents.lastMcpAt, since24h))),
      db.select({ c: count() }).from(agents).where(isNotNull(agents.recalledAt)),
      db
        .select({ c: count() })
        .from(matches)
        .where(and(eq(matches.status, "completed"), gte(matches.completedAt, since24h))),
      db
        .select({ c: count() })
        .from(matches)
        .where(and(eq(matches.status, "completed"), gte(matches.completedAt, since7d))),
      db.select({ c: count() }).from(matches).where(eq(matches.status, "completed")),
      db
        .select({
          v: sql<number>`COALESCE(SUM(${matches.potUsdc}), 0)::bigint`,
        })
        .from(matches)
        .where(and(eq(matches.status, "completed"), eq(matches.mode, "paid"))),
      db
        .select({
          v: sql<number>`COALESCE(SUM(${matches.potUsdc}), 0)::bigint`,
        })
        .from(matches)
        .where(
          and(
            eq(matches.status, "completed"),
            eq(matches.mode, "paid"),
            gte(matches.completedAt, since7d),
          ),
        ),
      db
        .select({
          v: sql<number>`COALESCE(SUM(${matches.platformFeeUsdc}), 0)::bigint`,
        })
        .from(matches)
        .where(and(eq(matches.status, "completed"), eq(matches.mode, "paid"))),
      db
        .select({
          v: sql<number>`COALESCE(SUM(${matches.platformFeeUsdc}), 0)::bigint`,
        })
        .from(matches)
        .where(
          and(
            eq(matches.status, "completed"),
            eq(matches.mode, "paid"),
            gte(matches.completedAt, since7d),
          ),
        ),
      // Top 10 earners (30d, by net = pot - fee - own stake).
      db
        .select({
          agentId: matches.winnerAgentId,
          net: sql<number>`COALESCE(SUM(${matches.potUsdc} - COALESCE(${matches.platformFeeUsdc}, 0) - (${matches.potUsdc} / 2)), 0)::bigint`,
          wins: sql<number>`COUNT(*)::int`,
        })
        .from(matches)
        .where(
          and(
            eq(matches.status, "completed"),
            eq(matches.mode, "paid"),
            isNotNull(matches.winnerAgentId),
            gte(matches.completedAt, since30d),
          ),
        )
        .groupBy(matches.winnerAgentId)
        .orderBy(desc(sql<number>`SUM(${matches.potUsdc})`))
        .limit(10),
    ]);

    // Resolve handles for top earners.
    const topEarnerIds = topEarnersRows
      .map((r) => r.agentId)
      .filter(Boolean) as string[];
    const handleMap = new Map<string, { handle: string; displayName: string; elo: number }>();
    if (topEarnerIds.length > 0) {
      const rows = await db
        .select({
          id: agents.id,
          handle: agents.handle,
          displayName: agents.displayName,
          elo: agents.elo,
        })
        .from(agents)
        .where(
          sql`${agents.id} IN (${sql.join(
            topEarnerIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        );
      for (const r of rows)
        handleMap.set(r.id, { handle: r.handle, displayName: r.displayName, elo: r.elo });
    }

    return NextResponse.json(
      {
        sampledAt: new Date().toISOString(),
        agents: {
          total: agentsTotalRow[0]?.c ?? 0,
          activeLast24h: activeAgentsRow[0]?.c ?? 0,
          recalled: recalledRow[0]?.c ?? 0,
        },
        matches: {
          completedTotal: completedTotalRow[0]?.c ?? 0,
          completedLast24h: completed24hRow[0]?.c ?? 0,
          completedLast7d: completed7dRow[0]?.c ?? 0,
        },
        money: {
          volumeStakedUsdcAllTime: Number(volumeAllRow[0]?.v ?? 0),
          volumeStakedUsdc7d: Number(volume7dRow[0]?.v ?? 0),
          feesCollectedUsdcAllTime: Number(feesAllRow[0]?.v ?? 0),
          feesCollectedUsdc7d: Number(fees7dRow[0]?.v ?? 0),
        },
        topEarners30d: topEarnersRows
          .map((r) => {
            const meta = r.agentId ? handleMap.get(r.agentId) : null;
            if (!meta) return null;
            return {
              handle: meta.handle,
              displayName: meta.displayName,
              elo: meta.elo,
              netUsdc: Number(r.net),
              wins: Number(r.wins),
            };
          })
          .filter(Boolean),
      },
      {
        headers: { "Cache-Control": "public, max-age=30, s-maxage=60" },
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
