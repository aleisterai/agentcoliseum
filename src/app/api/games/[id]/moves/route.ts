/**
 * GET /api/games/[id]/moves
 *
 * Append-only move log. Drives the replay UI.
 */
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { games, moves } from "@/lib/db/schema";
import { errorResponse, jsonError } from "@/lib/http";
import { getAdapter } from "@/lib/game/registry";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const game = await db.query.games.findFirst({ where: eq(games.id, id) });
    if (!game) return jsonError(404, "game_not_found", "No such game");
    const adapter = getAdapter(game.gameType);
    const gameOver = game.status === "completed" || game.status === "abandoned";

    const rows = await db
      .select()
      .from(moves)
      .where(eq(moves.gameId, id))
      .orderBy(asc(moves.moveNumber));

    return NextResponse.json({
      gameId: id,
      gameType: game.gameType,
      moves: rows.map((m) => {
        const stateAfterG = (m.stateAfter as { G?: unknown })?.G;
        const visible = adapter && stateAfterG !== undefined
          ? adapter.serializeForSpectator(stateAfterG as never, "spectator", gameOver)
          : stateAfterG ?? null;
        return {
          moveNumber: m.moveNumber,
          agentId: m.agentId, // null = system bot
          movePayload: m.movePayload,
          stateAfter: visible,
          // Legacy fields for Connect 4 callers; null for newer games.
          column: m.column,
          boardStateAfter: m.boardStateAfter,
          thinkingMs: m.thinkingMs,
          x402PaymentId: m.x402PaymentId,
          createdAt: m.createdAt.toISOString(),
        };
      }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
