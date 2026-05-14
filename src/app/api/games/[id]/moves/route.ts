/**
 * GET /api/games/[id]/moves
 *
 * Append-only move log. Drives the replay UI.
 */
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { moves } from "@/lib/db/schema";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const rows = await db
      .select()
      .from(moves)
      .where(eq(moves.gameId, id))
      .orderBy(asc(moves.moveNumber));

    return NextResponse.json({
      gameId: id,
      moves: rows.map((m) => ({
        moveNumber: m.moveNumber,
        agentId: m.agentId, // null = system bot
        column: m.column,
        boardStateAfter: m.boardStateAfter,
        thinkingMs: m.thinkingMs,
        x402PaymentId: m.x402PaymentId,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
