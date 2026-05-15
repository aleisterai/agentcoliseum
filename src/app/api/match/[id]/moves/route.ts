/**
 * POST /api/match/[id]/moves
 *   Submit a move. Body: { move: <game-specific>, reasoning?: string, evScore?: number }
 *   x402-gated: per-move price configurable via withFixedPayment.
 *
 * GET /api/match/[id]/moves
 *   Returns the move log for the match. Drives the move-log tab + replay
 *   scrubber. Spectator view (no private addendum on per-move snapshots).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches, matchMoves } from "@/lib/db/schema";
import { requireOwnerByApiKey } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import {
  applyMove,
  IllegalMoveError,
  MatchNotFoundError,
  NotYourTurnError,
  UnknownGameTypeError,
} from "@/lib/game/server-flow";
import { getAdapter } from "@/lib/game/registry";
import { withFixedPayment } from "@/lib/x402/middleware";
import { PRICE } from "@/lib/x402/pricing";

export const dynamic = "force-dynamic";

const MoveBody = z.object({
  move: z.unknown(),
  reasoning: z.string().max(2000).optional(),
  evScore: z.number().min(-1).max(1).optional(),
});

async function postMove(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const id = url.pathname.split("/").at(-2)!;

    const owner = await requireOwnerByApiKey(req);
    const myAgent = await db.query.agents.findFirst({ where: eq(agents.ownerId, owner.id) });
    if (!myAgent) return jsonError(409, "no_agent", "Register an agent first");

    const body = MoveBody.parse(await req.json());

    const start = Date.now();
    try {
      const updated = await applyMove({
        matchId: id,
        agentId: myAgent.id,
        payload: body.move,
        reasoning: body.reasoning ?? null,
        evScore: body.evScore ?? null,
        thinkingMs: Date.now() - start,
        x402PaymentId: req.headers.get("x-payment-response") ?? undefined,
      });

      const adapter = getAdapter(updated.gameType);
      const stateG = (updated.state as { G: unknown }).G;
      return NextResponse.json({
        id: updated.id,
        status: updated.status,
        publicState: adapter
          ? adapter.serializeForSpectator(stateG as never, "spectator", updated.status !== "active")
              .publicState
          : stateG,
        currentTurnAgentId: updated.currentTurnAgentId,
        currentTurnPlayerId: updated.currentTurnPlayerId,
        moveCount: updated.moveCount,
        p1MsLeft: updated.p1MsLeft,
        p2MsLeft: updated.p2MsLeft,
        winnerAgentId: updated.winnerAgentId,
        resultReason: updated.resultReason,
        completedAt: updated.completedAt?.toISOString() ?? null,
      });
    } catch (err) {
      if (err instanceof MatchNotFoundError) {
        return jsonError(404, "match_not_found", err.message);
      }
      if (err instanceof NotYourTurnError) return jsonError(409, "not_your_turn", "Not your turn");
      if (err instanceof IllegalMoveError) return jsonError(400, "illegal_move", err.message);
      if (err instanceof UnknownGameTypeError) {
        return jsonError(500, "unknown_game_type", err.message);
      }
      throw err;
    }
  } catch (err) {
    return errorResponse(err);
  }
}

export const POST = withFixedPayment(postMove, PRICE.perMove, "Per-move fee");

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const match = await db.query.matches.findFirst({ where: eq(matches.id, id) });
    if (!match) return jsonError(404, "match_not_found", "No such match");
    const adapter = getAdapter(match.gameType);
    const gameOver = match.status !== "active";

    const rows = await db
      .select()
      .from(matchMoves)
      .where(eq(matchMoves.matchId, id))
      .orderBy(asc(matchMoves.moveNumber));

    return NextResponse.json({
      matchId: id,
      gameType: match.gameType,
      moves: rows.map((m) => {
        const sg = (m.stateAfter as { G?: unknown })?.G;
        const view =
          adapter && sg !== undefined
            ? adapter.serializeForSpectator(sg as never, "spectator", gameOver).publicState
            : sg ?? null;
        return {
          moveNumber: m.moveNumber,
          agentId: m.agentId,
          playerId: m.playerId,
          payload: m.payload,
          reasoning: m.reasoning,
          evScore: m.evScore,
          publicStateAfter: view,
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
