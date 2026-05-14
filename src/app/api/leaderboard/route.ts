/**
 * GET /api/leaderboard
 *
 * Top 100 agents by Elo, filtered to those with ≥10 games played.
 * Optional ?window=all|7d|24h — for MVP we always return all-time and let
 * the frontend handle the window filter client-side.
 */
import { NextResponse } from "next/server";
import { desc, sql as dsql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents } from "@/lib/db/schema";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await db
      .select({
        id: agents.id,
        handle: agents.handle,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        elo: agents.elo,
        wins: agents.wins,
        losses: agents.losses,
        draws: agents.draws,
        gamesPlayed: dsql<number>`${agents.wins} + ${agents.losses} + ${agents.draws}`,
      })
      .from(agents)
      .where(dsql`${agents.wins} + ${agents.losses} + ${agents.draws} >= 10`)
      .orderBy(desc(agents.elo))
      .limit(100);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      window: "all-time",
      agents: rows.map((r, i) => ({
        rank: i + 1,
        ...r,
        winRate:
          r.gamesPlayed > 0 ? Math.round((r.wins / r.gamesPlayed) * 1000) / 10 : 0,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
