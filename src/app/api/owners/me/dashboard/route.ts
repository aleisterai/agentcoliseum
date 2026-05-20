/**
 * POST /api/owners/me/dashboard
 *
 * Returns the operator dashboard payload for the connected wallet:
 *   - KPIs (treasury balance proxy, active agents, 24h earnings/spend, avg ELO, open alerts)
 *   - Fleet table (the agents this owner has registered)
 *   - 30-day earnings sparkline series
 *   - Recent matches across the fleet
 *   - Treasury payout log (treasury_flows entries for the owner's matches)
 *
 * Auth: `Authorization: Bearer <privy-jwt>`.
 */
import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { getAddress } from "viem";
import { db } from "@/lib/db/client";
import {
  agents,
  matches,
  matchMoves,
  owners,
  treasuryFlows,
} from "@/lib/db/schema";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { deriveAgentStatus } from "@/lib/agent-status";
import { errorResponse, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const wallet = await resolvePrivyWallet(req);
    if (!wallet) throw new UnauthorizedError("unauthorized", "Privy session required");
    const checksummed = getAddress(wallet);

    const owner = await db.query.owners.findFirst({
      where: eq(owners.walletAddress, checksummed),
    });
    if (!owner) return jsonError(404, "owner_not_found", "Owner row not seeded — POST /api/owners/me first");

    const ownedAgents = await db
      .select({
        id: agents.id,
        handle: agents.handle,
        displayName: agents.displayName,
        elo: agents.elo,
        wins: agents.wins,
        losses: agents.losses,
        draws: agents.draws,
        createdAt: agents.createdAt,
        lastMcpAt: agents.lastMcpAt,
        recalledAt: agents.recalledAt,
        recalledBy: agents.recalledBy,
      })
      .from(agents)
      .where(eq(agents.ownerId, owner.id))
      .orderBy(desc(agents.elo));

    const ids = ownedAgents.map((a) => a.id);
    if (ids.length === 0) {
      return NextResponse.json({
        ownerId: owner.id,
        walletAddress: owner.walletAddress,
        kpis: emptyKpis(),
        fleet: [],
        earningsSeries: [],
        recentMatches: [],
        payouts: [],
      });
    }

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const fleetMatchClause = or(
      inArray(matches.p1AgentId, ids),
      inArray(matches.p2AgentId, ids),
    );

    const [earnings24hRow, earnings7dRow, x402Spend24hRow, recentRows, treasuryRows, earningsSeriesRows, fleetWinsLosses] =
      await Promise.all([
        db
          .select({
            earnings: sql<number>`COALESCE(SUM(${matches.potUsdc} - COALESCE(${matches.platformFeeUsdc}, 0)), 0)::bigint`,
            wins: sql<number>`COUNT(*)::int`,
          })
          .from(matches)
          .where(
            and(
              eq(matches.status, "completed"),
              inArray(matches.winnerAgentId, ids),
              gte(matches.completedAt, since24h),
            ),
          ),
        db
          .select({
            earnings: sql<number>`COALESCE(SUM(${matches.potUsdc} - COALESCE(${matches.platformFeeUsdc}, 0)), 0)::bigint`,
            wins: sql<number>`COUNT(*)::int`,
            winnerAgentId: matches.winnerAgentId,
          })
          .from(matches)
          .where(
            and(
              eq(matches.status, "completed"),
              inArray(matches.winnerAgentId, ids),
              gte(matches.completedAt, since7d),
            ),
          )
          .groupBy(matches.winnerAgentId),
        db
          .select({
            spend: sql<number>`COUNT(*) * 800::bigint`, // 0.0008 USDC ≈ 800 microUSDC per move
          })
          .from(matchMoves)
          .where(
            and(
              inArray(matchMoves.agentId, ids),
              gte(matchMoves.createdAt, since24h),
              sql`${matchMoves.x402PaymentId} IS NOT NULL`,
            ),
          ),
        db
          .select({
            id: matches.id,
            gameType: matches.gameType,
            mode: matches.mode,
            status: matches.status,
            p1AgentId: matches.p1AgentId,
            p2AgentId: matches.p2AgentId,
            winnerAgentId: matches.winnerAgentId,
            potUsdc: matches.potUsdc,
            p1EloDelta: matches.p1EloDelta,
            p2EloDelta: matches.p2EloDelta,
            startedAt: matches.startedAt,
            completedAt: matches.completedAt,
          })
          .from(matches)
          .where(fleetMatchClause)
          .orderBy(desc(matches.startedAt))
          .limit(16),
        db
          .select({
            id: treasuryFlows.id,
            matchId: treasuryFlows.matchId,
            feeUsdc: treasuryFlows.feeUsdc,
            status: treasuryFlows.status,
            treasuryTxHash: treasuryFlows.treasuryTxHash,
            createdAt: treasuryFlows.createdAt,
          })
          .from(treasuryFlows)
          .where(
            sql`${treasuryFlows.matchId} IN (
              SELECT id FROM ${matches} WHERE p1_agent_id IN (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `,
              )}) OR p2_agent_id IN (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `,
              )})
            )`,
          )
          .orderBy(desc(treasuryFlows.createdAt))
          .limit(20),
        db
          .select({
            day: sql<string>`DATE_TRUNC('day', ${matches.completedAt})::date::text`,
            earnings: sql<number>`COALESCE(SUM(${matches.potUsdc} - COALESCE(${matches.platformFeeUsdc}, 0)), 0)::bigint`,
          })
          .from(matches)
          .where(
            and(
              eq(matches.status, "completed"),
              inArray(matches.winnerAgentId, ids),
              gte(matches.completedAt, since30d),
            ),
          )
          .groupBy(sql`DATE_TRUNC('day', ${matches.completedAt})`)
          .orderBy(sql`DATE_TRUNC('day', ${matches.completedAt})`),
        // Per-agent 7d wins / losses count
        db
          .select({
            agentId: sql<string>`agent_id`,
            wins: sql<number>`COUNT(*) FILTER (WHERE winner_agent_id = agent_id)::int`,
            losses: sql<number>`COUNT(*) FILTER (WHERE winner_agent_id IS NOT NULL AND winner_agent_id <> agent_id)::int`,
            earnings: sql<number>`COALESCE(SUM(CASE WHEN winner_agent_id = agent_id THEN (${matches.potUsdc} - COALESCE(${matches.platformFeeUsdc}, 0)) ELSE 0 END), 0)::bigint`,
          })
          .from(
            sql`(
              SELECT ${matches.id} AS id, ${matches.p1AgentId} AS agent_id, ${matches.p2AgentId} AS opp_id, ${matches.winnerAgentId} AS winner_agent_id, ${matches.potUsdc} AS pot_usdc, ${matches.platformFeeUsdc} AS platform_fee_usdc, ${matches.completedAt} AS completed_at, ${matches.status} AS status FROM ${matches} WHERE ${matches.p1AgentId} IN (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `,
              )})
              UNION ALL
              SELECT ${matches.id} AS id, ${matches.p2AgentId} AS agent_id, ${matches.p1AgentId} AS opp_id, ${matches.winnerAgentId} AS winner_agent_id, ${matches.potUsdc} AS pot_usdc, ${matches.platformFeeUsdc} AS platform_fee_usdc, ${matches.completedAt} AS completed_at, ${matches.status} AS status FROM ${matches} WHERE ${matches.p2AgentId} IN (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `,
              )})
            ) t`,
          )
          // Interpolating a JS Date into a raw sql`...` template stringifies
          // with Date.toString() ("Mon May 11 2026 17:48:52 GMT-0700") which
          // postgres-js rejects with ERR_INVALID_ARG_TYPE. Convert to ISO so
          // the driver gets a string it can hand to Postgres as timestamptz.
          .where(sql`status = 'completed' AND completed_at >= ${since7d.toISOString()}`)
          .groupBy(sql`agent_id`),
      ]);

    const earnings7dByAgent = Object.fromEntries(
      fleetWinsLosses.map((r) => [r.agentId, r]),
    );

    // Status compute is shared with the agent profile page via
    // `@/lib/agent-status` so both surfaces always agree.
    const fleet = ownedAgents.map((a) => {
      const sevenDay = earnings7dByAgent[a.id];
      const status = deriveAgentStatus({
        recalledAt: a.recalledAt,
        lastMcpAt: a.lastMcpAt,
      });
      return {
        id: a.id,
        handle: a.handle,
        displayName: a.displayName,
        elo: a.elo,
        wins: a.wins,
        losses: a.losses,
        draws: a.draws,
        winsSevenDay: Number(sevenDay?.wins ?? 0),
        lossesSevenDay: Number(sevenDay?.losses ?? 0),
        earnings7d: Number(sevenDay?.earnings ?? 0),
        status,
        lastMcpAt: a.lastMcpAt?.toISOString() ?? null,
        recalledAt: a.recalledAt?.toISOString() ?? null,
        recalledBy: a.recalledBy,
        createdAt: a.createdAt.toISOString(),
      };
    });

    const avgElo =
      ownedAgents.length > 0
        ? Math.round(
            ownedAgents.reduce((acc, a) => acc + a.elo, 0) / ownedAgents.length,
          )
        : 0;
    const totalEarnings7d = fleet.reduce((acc, f) => acc + f.earnings7d, 0);

    const kpis = {
      treasuryBalance: totalEarnings7d, // proxy: cumulative 7d earnings
      // "Active" = status="active" (connected + last MCP call within 24h, not
      // recalled). NOT_CONNECTED / IDLE / RECALLED agents don't count.
      activeAgents: fleet.filter((f) => f.status === "active").length,
      earnings24h: Number(earnings24hRow[0]?.earnings ?? 0),
      wins24h: Number(earnings24hRow[0]?.wins ?? 0),
      x402Spend24h: Number(x402Spend24hRow[0]?.spend ?? 0),
      avgElo,
      alertsOpen: 0,
    };

    return NextResponse.json({
      ownerId: owner.id,
      walletAddress: owner.walletAddress,
      kpis,
      fleet,
      earningsSeries: earningsSeriesRows.map((r) => ({
        day: r.day,
        amount: Number(r.earnings),
      })),
      recentMatches: recentRows.map((m) => ({
        id: m.id,
        gameType: m.gameType,
        mode: m.mode,
        status: m.status,
        p1AgentId: m.p1AgentId,
        p2AgentId: m.p2AgentId,
        winnerAgentId: m.winnerAgentId,
        potUsdc: m.potUsdc,
        p1EloDelta: m.p1EloDelta,
        p2EloDelta: m.p2EloDelta,
        startedAt: m.startedAt.toISOString(),
        completedAt: m.completedAt?.toISOString() ?? null,
      })),
      payouts: treasuryRows.map((t) => ({
        id: t.id,
        matchId: t.matchId,
        feeUsdc: t.feeUsdc,
        status: t.status,
        txHash: t.treasuryTxHash,
        createdAt: t.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function emptyKpis() {
  return {
    treasuryBalance: 0,
    activeAgents: 0,
    earnings24h: 0,
    wins24h: 0,
    x402Spend24h: 0,
    avgElo: 0,
    alertsOpen: 0,
  };
}
