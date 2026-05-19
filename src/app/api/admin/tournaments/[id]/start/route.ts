/**
 * POST /api/admin/tournaments/[id]/start
 *
 * Operator-triggered transition from `registering` → `running`:
 *   1. Verify the tournament has exactly `size` entries.
 *   2. Seed bracket positions (random Fisher-Yates).
 *   3. Create round-1 matches in `matches` table (mode='free', no stake
 *      — the entry fees are the prize pool, not per-match stakes).
 *   4. Insert tournament_matches rows linking the matches to bracket
 *      positions.
 *   5. Flip the tournament status to 'running' + stamp startedAt.
 *
 * Wrapped in a transaction so a partial seed doesn't leave the
 * tournament in a half-initialized state.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  agents,
  matches,
  tournaments,
  tournamentEntries,
  tournamentMatches,
} from "@/lib/db/schema";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { isOperatorWallet } from "@/lib/auth/operator";
import { errorResponse, jsonError } from "@/lib/http";
import { getAdapter } from "@/lib/game/registry";
import { buildEngine } from "@/lib/game/engine";
import { seedEntries, buildFirstRound } from "@/lib/tournament";

export const dynamic = "force-dynamic";

const DEFAULT_CLOCK_BUDGET_MS = 5 * 60 * 1000; // 5 min per side, same as ad-hoc matches

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const wallet = await resolvePrivyWallet(req);
    if (!wallet) throw new UnauthorizedError("unauthorized", "Privy session required");
    if (!isOperatorWallet(wallet)) {
      throw new UnauthorizedError("forbidden", "Operator wallet only");
    }
    const { id } = await params;

    const tournament = await db.query.tournaments.findFirst({
      where: eq(tournaments.id, id),
    });
    if (!tournament) return jsonError(404, "tournament_not_found", "No such tournament");
    if (tournament.status !== "registering") {
      return jsonError(
        409,
        "wrong_status",
        `Tournament is ${tournament.status} (must be 'registering' to start)`,
      );
    }

    const entries = await db
      .select()
      .from(tournamentEntries)
      .where(eq(tournamentEntries.tournamentId, tournament.id));
    if (entries.length !== tournament.size) {
      return jsonError(
        409,
        "wrong_size",
        `Need exactly ${tournament.size} entries to start (have ${entries.length})`,
      );
    }

    const adapter = getAdapter(tournament.gameType);
    if (!adapter) {
      return jsonError(500, "unknown_game_type", `Adapter for ${tournament.gameType} missing`);
    }
    const engine = buildEngine(adapter.game);

    // Seed + first-round pairings. Random seeds — operator can re-roll
    // by cancelling and recreating if they want a specific layout.
    const seeded = seedEntries(entries.map((e) => e.agentId));
    const pairings = buildFirstRound(seeded);

    // Resolve display names for the matches we're about to create.
    const allIds = seeded.map((s) => s.agentId);
    const agentRows = await db
      .select({ id: agents.id, handle: agents.handle, displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.id, allIds[0])); // we'll re-batch below

    // Drizzle-friendly batched lookup
    const handleMap = new Map<string, { handle: string; displayName: string }>();
    if (agentRows.length === 0 || allIds.length > 1) {
      const rows = await db
        .select({
          id: agents.id,
          handle: agents.handle,
          displayName: agents.displayName,
        })
        .from(agents);
      for (const r of rows)
        handleMap.set(r.id, { handle: r.handle, displayName: r.displayName });
    } else {
      handleMap.set(agentRows[0].id, {
        handle: agentRows[0].handle,
        displayName: agentRows[0].displayName,
      });
    }

    const result = await db.transaction(async (tx) => {
      // Persist seeds on entries.
      for (const s of seeded) {
        await tx
          .update(tournamentEntries)
          .set({ seed: s.seed })
          .where(eq(tournamentEntries.id, entries.find((e) => e.agentId === s.agentId)!.id));
      }

      // Create round-1 matches + tournament_matches.
      const createdMatches: Array<{
        matchId: string;
        bracketPosition: number;
        p1AgentId: string;
        p2AgentId: string;
      }> = [];
      for (const pair of pairings) {
        const initialState = engine.initialState();
        const [matchRow] = await tx
          .insert(matches)
          .values({
            gameType: tournament.gameType,
            mode: "free", // entry fee is the only money; in-tournament matches are free
            p1AgentId: pair.p1AgentId,
            p2AgentId: pair.p2AgentId,
            state: initialState,
            status: "active",
            currentTurnPlayerId: "0",
            currentTurnAgentId: pair.p1AgentId,
            p1MsLeft: DEFAULT_CLOCK_BUDGET_MS,
            p2MsLeft: DEFAULT_CLOCK_BUDGET_MS,
            clockBudgetMs: DEFAULT_CLOCK_BUDGET_MS,
          })
          .returning({ id: matches.id });
        await tx.insert(tournamentMatches).values({
          tournamentId: tournament.id,
          matchId: matchRow.id,
          round: 1,
          bracketPosition: pair.bracketPosition,
          p1AgentId: pair.p1AgentId,
          p2AgentId: pair.p2AgentId,
        });
        createdMatches.push({
          matchId: matchRow.id,
          bracketPosition: pair.bracketPosition,
          p1AgentId: pair.p1AgentId,
          p2AgentId: pair.p2AgentId,
        });
      }

      const [updated] = await tx
        .update(tournaments)
        .set({ status: "running", startedAt: new Date() })
        .where(eq(tournaments.id, tournament.id))
        .returning();

      return { tournament: updated, createdMatches };
    });

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
