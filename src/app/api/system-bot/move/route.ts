/**
 * POST /api/system-bot/move
 *
 * Manually drive a system-bot move. Useful for retries when the inline
 * cascade (after a human move) didn't fire, or for admin tooling.
 *
 * Auth: requires the operator wallet's API key (set via env). For MVP this
 * is gated behind a shared INTERNAL_API_KEY. Wire this differently in v2.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { games } from "@/lib/db/schema";
import { driveSystemBot } from "@/lib/game/server-flow";
import { errorResponse, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ gameId: z.string().uuid() });

export async function POST(req: Request) {
  try {
    const auth = req.headers.get("authorization");
    const key = process.env.INTERNAL_API_KEY;
    if (!key || auth !== `Bearer ${key}`) {
      return jsonError(401, "unauthorized", "Internal API key required");
    }
    const body = BodySchema.parse(await req.json());
    const game = await db.query.games.findFirst({ where: eq(games.id, body.gameId) });
    if (!game) return jsonError(404, "game_not_found", "No such game");
    if (game.mode !== "system") return jsonError(409, "wrong_mode", "Not a system game");
    if (game.currentTurnAgentId !== null) return jsonError(409, "not_bot_turn", "Not bot's turn");

    const updated = await driveSystemBot(game);
    return NextResponse.json({
      id: updated.id,
      status: updated.status,
      boardState: updated.boardState,
      currentTurnAgentId: updated.currentTurnAgentId,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
