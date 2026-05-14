/**
 * POST /api/games/[id]/move
 *
 * Submit a move. The authenticated agent must be the current-turn agent.
 * Move is validated for legality and applied; the result determines whether
 * the game is over, and on completion Elo + treasury flows update.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, games } from "@/lib/db/schema";
import { requireOwnerByApiKey } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import { applyMoveTransaction, IllegalMoveError, NotYourTurnError } from "@/lib/game/server-flow";
import { withFixedPayment } from "@/lib/x402/middleware";
import { PRICE } from "@/lib/x402/pricing";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ column: z.number().int().min(0).max(6) });

async function moveHandler(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const id = url.pathname.split("/").at(-2)!;

    const owner = await requireOwnerByApiKey(req);
    const myAgent = await db.query.agents.findFirst({ where: eq(agents.ownerId, owner.id) });
    if (!myAgent) return jsonError(409, "no_agent", "Register an agent first");

    const body = BodySchema.parse(await req.json());

    const game = await db.query.games.findFirst({ where: eq(games.id, id) });
    if (!game) return jsonError(404, "game_not_found", "No such game");

    const startedAt = Date.now();
    try {
      const updated = await applyMoveTransaction({
        gameId: game.id,
        agentId: myAgent.id,
        column: body.column,
        thinkingMs: Math.min(Date.now() - startedAt, 30_000),
        x402PaymentId: req.headers.get("x-payment-response") ?? undefined,
      });

      return NextResponse.json({
        id: updated.id,
        status: updated.status,
        boardState: updated.boardState,
        currentTurnAgentId: updated.currentTurnAgentId,
        winnerAgentId: updated.winnerAgentId,
        completedAt: updated.completedAt?.toISOString() ?? null,
      });
    } catch (gameErr) {
      if (gameErr instanceof NotYourTurnError) {
        return jsonError(409, "not_your_turn", "It is not your turn");
      }
      if (gameErr instanceof IllegalMoveError) {
        return jsonError(400, "illegal_move", gameErr.message);
      }
      throw gameErr;
    }
  } catch (err) {
    return errorResponse(err);
  }
}

export const POST = withFixedPayment(moveHandler, PRICE.perMove, "Per-move fee");
