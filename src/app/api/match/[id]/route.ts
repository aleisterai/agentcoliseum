/**
 * GET /api/match/[id]
 *
 * Returns match state. Public — spectators load this to render the board.
 * For imperfect-info games the adapter's `serializeForSpectator` strips
 * hidden state. If a Bearer header is sent and matches one of the playing
 * agents, that player's `privateAddendum` is included.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches, owners } from "@/lib/db/schema";
import { errorResponse, jsonError } from "@/lib/http";
import { getAdapter } from "@/lib/game/registry";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const match = await db.query.matches.findFirst({ where: eq(matches.id, id) });
    if (!match) return jsonError(404, "match_not_found", `Match ${id} does not exist`);

    const adapter = getAdapter(match.gameType);
    const gameOver = match.status !== "active";

    // Viewer detection
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
            if (myAgent.id === match.p1AgentId) viewer = "0";
            else if (myAgent.id === match.p2AgentId) viewer = "1";
          }
        }
      }
    }

    const stateG = (match.state as { G: unknown }).G;
    const view = adapter
      ? adapter.serializeForSpectator(stateG as never, viewer, gameOver)
      : { publicState: stateG };

    return NextResponse.json({
      id: match.id,
      gameType: match.gameType,
      mode: match.mode,
      status: match.status,
      p1AgentId: match.p1AgentId,
      p2AgentId: match.p2AgentId,
      systemBotDifficulty: match.systemBotDifficulty,
      stakeUsdc: match.stakeUsdc,
      potUsdc: match.potUsdc,
      publicState: view.publicState,
      privateAddendum: viewer === "spectator" ? undefined : view.privateAddendum,
      currentTurnPlayerId: match.currentTurnPlayerId,
      currentTurnAgentId: match.currentTurnAgentId,
      turnStartedAt: match.turnStartedAt.toISOString(),
      p1MsLeft: match.p1MsLeft,
      p2MsLeft: match.p2MsLeft,
      clockBudgetMs: match.clockBudgetMs,
      moveCount: match.moveCount,
      winnerAgentId: match.winnerAgentId,
      resultReason: match.resultReason,
      p1EloDelta: match.p1EloDelta,
      p2EloDelta: match.p2EloDelta,
      startedAt: match.startedAt.toISOString(),
      lastMoveAt: match.lastMoveAt?.toISOString() ?? null,
      completedAt: match.completedAt?.toISOString() ?? null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
