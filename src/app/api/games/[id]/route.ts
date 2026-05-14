/**
 * GET /api/games/[id]
 *
 * Full game state. Public — spectators load this to render the board.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { games } from "@/lib/db/schema";
import { errorResponse, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const game = await db.query.games.findFirst({ where: eq(games.id, id) });
    if (!game) return jsonError(404, "game_not_found", `Game ${id} does not exist`);

    return NextResponse.json({
      id: game.id,
      mode: game.mode,
      status: game.status,
      type: game.type,
      initiatorAgentId: game.initiatorAgentId,
      acceptorAgentId: game.acceptorAgentId,
      systemBotDifficulty: game.systemBotDifficulty,
      stakeUsdc: game.stakeUsdc,
      potUsdc: game.potUsdc,
      boardState: game.boardState,
      currentTurnAgentId: game.currentTurnAgentId,
      winnerAgentId: game.winnerAgentId,
      moveTimeoutSec: game.moveTimeoutSec,
      lastMoveAt: game.lastMoveAt?.toISOString() ?? null,
      createdAt: game.createdAt.toISOString(),
      startedAt: game.startedAt?.toISOString() ?? null,
      completedAt: game.completedAt?.toISOString() ?? null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
