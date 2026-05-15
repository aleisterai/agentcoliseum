/**
 * GET /api/games/[id]
 *
 * Full game state. Public — spectators load this to render the board.
 *
 * For imperfect-information games (Battleship, Liar's Dice) the adapter's
 * `serializeForSpectator` redacts hidden state based on the viewer. Today the
 * viewer is detected from the optional `Authorization: Bearer <api-key>`
 * header: if it matches one of the game's player agents, that player gets
 * their own private view; otherwise the request is treated as a spectator.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, games, owners } from "@/lib/db/schema";
import { errorResponse, jsonError } from "@/lib/http";
import { getAdapter } from "@/lib/game/registry";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const game = await db.query.games.findFirst({ where: eq(games.id, id) });
    if (!game) return jsonError(404, "game_not_found", `Game ${id} does not exist`);

    const adapter = getAdapter(game.gameType);
    const gameOver = game.status === "completed" || game.status === "abandoned";

    // Viewer detection: only consult the DB if a Bearer header is present.
    let viewer: "0" | "1" | "spectator" = "spectator";
    const auth = req.headers.get("authorization");
    if (auth?.startsWith("Bearer ")) {
      const key = auth.slice("Bearer ".length).trim();
      if (key) {
        const owner = await db.query.owners.findFirst({ where: eq(owners.apiKey, key) });
        if (owner) {
          const myAgent = await db.query.agents.findFirst({
            where: eq(agents.ownerId, owner.id),
          });
          if (myAgent) {
            if (myAgent.id === game.initiatorAgentId) viewer = "0";
            else if (myAgent.id === game.acceptorAgentId) viewer = "1";
          }
        }
      }
    }

    const stateG = (game.state as { G: unknown }).G;
    const visibleState = adapter
      ? adapter.serializeForSpectator(stateG as never, viewer, gameOver)
      : stateG;

    return NextResponse.json({
      id: game.id,
      gameType: game.gameType,
      mode: game.mode,
      status: game.status,
      initiatorAgentId: game.initiatorAgentId,
      acceptorAgentId: game.acceptorAgentId,
      systemBotDifficulty: game.systemBotDifficulty,
      stakeUsdc: game.stakeUsdc,
      potUsdc: game.potUsdc,
      state: visibleState,
      // Legacy mirror for callers still reading boardState; null for non-Connect-4.
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
