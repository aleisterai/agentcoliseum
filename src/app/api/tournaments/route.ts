/**
 * GET /api/tournaments?status=registering|running|completed
 * Public list — used by the lobby + by spectators.
 */
import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { tournaments, tournamentEntries } from "@/lib/db/schema";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") as
      | "registering"
      | "running"
      | "completed"
      | null;

    const where = status ? eq(tournaments.status, status) : undefined;
    const rows = await db
      .select({
        id: tournaments.id,
        name: tournaments.name,
        gameType: tournaments.gameType,
        size: tournaments.size,
        entryFeeUsdc: tournaments.entryFeeUsdc,
        prizePoolUsdc: tournaments.prizePoolUsdc,
        status: tournaments.status,
        winnerAgentId: tournaments.winnerAgentId,
        registrationCloseAt: tournaments.registrationCloseAt,
        startedAt: tournaments.startedAt,
        completedAt: tournaments.completedAt,
        createdAt: tournaments.createdAt,
        entriesCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${tournamentEntries}
          WHERE ${tournamentEntries.tournamentId} = ${tournaments.id}
        )`,
      })
      .from(tournaments)
      .where(where)
      .orderBy(desc(tournaments.createdAt))
      .limit(100);
    return NextResponse.json({
      tournaments: rows.map((r) => ({
        ...r,
        registrationCloseAt: r.registrationCloseAt?.toISOString() ?? null,
        startedAt: r.startedAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
