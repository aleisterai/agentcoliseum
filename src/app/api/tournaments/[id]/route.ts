/**
 * GET /api/tournaments/[id] — full tournament + bracket detail.
 *
 * Returns the tournament row, all entries (with handles), and every
 * tournament_match grouped by round. The public bracket page renders
 * directly from this shape.
 */
import { NextResponse } from "next/server";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  agents,
  matches,
  tournaments,
  tournamentEntries,
  tournamentMatches,
} from "@/lib/db/schema";
import { errorResponse, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const tournament = await db.query.tournaments.findFirst({
      where: eq(tournaments.id, id),
    });
    if (!tournament) return jsonError(404, "tournament_not_found", "No such tournament");

    const [entryRows, matchRows] = await Promise.all([
      db
        .select()
        .from(tournamentEntries)
        .where(eq(tournamentEntries.tournamentId, tournament.id))
        .orderBy(asc(tournamentEntries.seed)),
      db
        .select()
        .from(tournamentMatches)
        .where(eq(tournamentMatches.tournamentId, tournament.id))
        .orderBy(asc(tournamentMatches.round), asc(tournamentMatches.bracketPosition)),
    ]);

    // Resolve agent handles in one batch.
    const agentIds = new Set<string>();
    for (const e of entryRows) agentIds.add(e.agentId);
    for (const m of matchRows) {
      if (m.p1AgentId) agentIds.add(m.p1AgentId);
      if (m.p2AgentId) agentIds.add(m.p2AgentId);
      if (m.winnerAgentId) agentIds.add(m.winnerAgentId);
    }
    if (tournament.winnerAgentId) agentIds.add(tournament.winnerAgentId);

    const handleRows = agentIds.size
      ? await db
          .select({
            id: agents.id,
            handle: agents.handle,
            displayName: agents.displayName,
            elo: agents.elo,
          })
          .from(agents)
          .where(inArray(agents.id, [...agentIds]))
      : [];
    const map = new Map(handleRows.map((r) => [r.id, r]));
    const fmt = (id: string | null) => (id ? map.get(id) ?? null : null);

    // Pull underlying-match statuses so the bracket can show live / done.
    const matchIds = matchRows.map((m) => m.matchId).filter(Boolean) as string[];
    const matchStatusMap = new Map<string, string>();
    if (matchIds.length) {
      const ms = await db
        .select({ id: matches.id, status: matches.status })
        .from(matches)
        .where(inArray(matches.id, matchIds));
      for (const m of ms) matchStatusMap.set(m.id, m.status);
    }

    return NextResponse.json({
      tournament: {
        ...tournament,
        winner: fmt(tournament.winnerAgentId),
        registrationCloseAt: tournament.registrationCloseAt?.toISOString() ?? null,
        startedAt: tournament.startedAt?.toISOString() ?? null,
        completedAt: tournament.completedAt?.toISOString() ?? null,
        createdAt: tournament.createdAt.toISOString(),
      },
      entries: entryRows.map((e) => ({
        ...e,
        agent: fmt(e.agentId),
        registeredAt: e.registeredAt.toISOString(),
      })),
      bracket: matchRows.map((m) => ({
        ...m,
        p1: fmt(m.p1AgentId),
        p2: fmt(m.p2AgentId),
        winner: fmt(m.winnerAgentId),
        matchStatus: m.matchId ? matchStatusMap.get(m.matchId) ?? null : null,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
