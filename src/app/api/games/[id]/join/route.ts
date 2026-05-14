/**
 * POST /api/games/[id]/join
 *
 * Accept an open challenge. Requires Play tier for free games, also Play tier
 * for paid games (the initiator was the one held to Initiator tier when posting).
 */
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, games } from "@/lib/db/schema";
import { requireOwnerByApiKey } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import { requireTier } from "@/lib/chain/tiers";
import { withDynamicPayment } from "@/lib/x402/middleware";
import { dollarsFromUsdc6 } from "@/lib/x402/pricing";
import { broadcastGame, broadcastLobby, realtimeEvent } from "@/lib/realtime";

export const dynamic = "force-dynamic";

async function joinHandler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const owner = await requireOwnerByApiKey(req);
    await requireTier(owner.walletAddress as `0x${string}`, "play");

    const myAgent = await db.query.agents.findFirst({ where: eq(agents.ownerId, owner.id) });
    if (!myAgent) return jsonError(409, "no_agent", "Register an agent first");

    const game = await db.query.games.findFirst({ where: eq(games.id, id) });
    if (!game) return jsonError(404, "game_not_found", "No such game");
    if (game.status !== "lobby") return jsonError(409, "not_open", "Game is no longer open");
    if (game.initiatorAgentId === myAgent.id) {
      return jsonError(409, "cannot_self_join", "You cannot accept your own challenge");
    }

    const now = new Date();
    const [updated] = await db
      .update(games)
      .set({
        acceptorAgentId: myAgent.id,
        status: "active",
        startedAt: now,
        lastMoveAt: now,
        currentTurnAgentId: game.initiatorAgentId, // initiator goes first
      })
      .where(eq(games.id, id))
      .returning();

    await Promise.all([
      broadcastLobby(realtimeEvent.GameJoined, { id: updated.id }),
      broadcastGame(updated.id, realtimeEvent.GameJoined, {
        id: updated.id,
        currentTurnAgentId: updated.currentTurnAgentId,
      }),
    ]);

    return NextResponse.json({
      id: updated.id,
      status: updated.status,
      currentTurnAgentId: updated.currentTurnAgentId,
      startedAt: updated.startedAt?.toISOString(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export const POST = withDynamicPayment(
  // x402-next gives us the request; we forward to the param-aware handler.
  // The route context (params) is available via the route file location.
  (req: NextRequest) => {
    const url = new URL(req.url);
    const id = url.pathname.split("/").at(-2)!;
    return joinHandler(req, { params: Promise.resolve({ id }) });
  },
  async (req) => {
    // Free / system games: $0.01 anti-spam. Paid: match the stake.
    const url = new URL(req.url);
    const id = url.pathname.split("/").at(-2)!;
    const game = await db.query.games.findFirst({ where: eq(games.id, id) });
    if (game?.mode === "paid" && game.stakeUsdc) {
      return dollarsFromUsdc6(game.stakeUsdc);
    }
    return "$0.01";
  },
  "Join game",
);
