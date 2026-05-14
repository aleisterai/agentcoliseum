/**
 * GET  /api/games?status=lobby     — list open challenges
 * POST /api/games                  — create a game
 *
 * For paid games the initiator must be Initiator tier (50M); free and system
 * mode only need Play tier (20M).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, games } from "@/lib/db/schema";
import { requireOwnerByApiKey } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import { requireTier } from "@/lib/chain/tiers";
import { emptyBoard } from "@/lib/game/connect4";
import { withDynamicPayment } from "@/lib/x402/middleware";
import { dollarsFromUsdc6 } from "@/lib/x402/pricing";
import { broadcastLobby, realtimeEvent } from "@/lib/realtime";

export const dynamic = "force-dynamic";

// ---------- GET lobby ----------

const LobbyQuerySchema = z.object({
  status: z.enum(["lobby", "active", "completed"]).optional().default("lobby"),
});

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const { status } = LobbyQuerySchema.parse({ status: searchParams.get("status") ?? undefined });

    const rows = await db
      .select({
        id: games.id,
        mode: games.mode,
        status: games.status,
        stakeUsdc: games.stakeUsdc,
        initiatorAgentId: games.initiatorAgentId,
        createdAt: games.createdAt,
      })
      .from(games)
      .where(and(eq(games.status, status), isNull(games.acceptorAgentId)))
      .orderBy(desc(games.createdAt))
      .limit(100);

    return NextResponse.json({ games: rows });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------- POST create ----------

const CreateBodySchema = z
  .object({
    mode: z.enum(["free", "paid", "system"]),
    stakeUsdc: z.number().int().positive().optional(),
    opponentHandle: z.string().optional(),
    systemBotDifficulty: z.enum(["easy", "medium", "hard"]).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === "paid" && !v.stakeUsdc) {
      ctx.addIssue({ code: "custom", path: ["stakeUsdc"], message: "stakeUsdc required for paid mode" });
    }
    if (v.mode === "system" && !v.systemBotDifficulty) {
      ctx.addIssue({
        code: "custom",
        path: ["systemBotDifficulty"],
        message: "systemBotDifficulty required for system mode",
      });
    }
  });

async function createHandler(req: NextRequest) {
  try {
    const owner = await requireOwnerByApiKey(req);
    const body = CreateBodySchema.parse(await req.json());

    // Tier gates
    if (body.mode === "paid") {
      await requireTier(owner.walletAddress as `0x${string}`, "initiator");
    } else {
      await requireTier(owner.walletAddress as `0x${string}`, "play");
    }

    // Owner must have at least one agent.
    const myAgent = await db.query.agents.findFirst({ where: eq(agents.ownerId, owner.id) });
    if (!myAgent) {
      return jsonError(409, "no_agent", "Register an agent first via POST /api/agents/register");
    }

    const initialStatus = body.mode === "system" ? "active" : "lobby";
    const initialBoard = emptyBoard();
    const [created] = await db
      .insert(games)
      .values({
        mode: body.mode,
        status: initialStatus,
        type: "connect4",
        initiatorAgentId: myAgent.id,
        // system games auto-start; initiator goes first
        currentTurnAgentId: body.mode === "system" ? myAgent.id : null,
        systemBotDifficulty: body.mode === "system" ? body.systemBotDifficulty : null,
        stakeUsdc: body.mode === "paid" ? body.stakeUsdc : null,
        potUsdc: body.mode === "paid" ? body.stakeUsdc! * 2 : null,
        platformFeeUsdc: body.mode === "paid" ? Math.round(body.stakeUsdc! * 2 * 0.05) : null,
        boardState: initialBoard,
        startedAt: body.mode === "system" ? new Date() : null,
        lastMoveAt: body.mode === "system" ? new Date() : null,
      })
      .returning();

    await broadcastLobby(realtimeEvent.GameCreated, { id: created.id, mode: created.mode });

    return NextResponse.json(
      {
        id: created.id,
        mode: created.mode,
        status: created.status,
        boardState: created.boardState,
        stakeUsdc: created.stakeUsdc,
        currentTurnAgentId: created.currentTurnAgentId,
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

// Dynamic pricing: $0.01 for free/system, stake amount for paid.
export const POST = withDynamicPayment(
  createHandler,
  async (req) => {
    const cloned = req.clone();
    const body = await cloned.json().catch(() => ({}));
    if (body.mode === "paid" && typeof body.stakeUsdc === "number") {
      return dollarsFromUsdc6(body.stakeUsdc);
    }
    return "$0.01";
  },
  "Game creation",
);
