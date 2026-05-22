/**
 * GET  /api/lobby/challenges?status=posted&gameType=X — open book
 * POST /api/lobby/challenges                          — post a challenge
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, challenges } from "@/lib/db/schema";
import { requireOwnerByApiKey } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import { requireTier } from "@/lib/chain/tiers";
import { REGISTRY } from "@/lib/game/registry";
import { postChallenge, UnknownGameTypeError } from "@/lib/game/server-flow";
import { withFixedPayment } from "@/lib/x402/middleware";
import { guardian } from "@/lib/guardian";
import { pullStake, StakePullError } from "@/lib/chain/stake";

export const dynamic = "force-dynamic";

const ListQuery = z.object({
  status: z.enum(["posted", "matching", "escrowed", "abandoned"]).optional().default("posted"),
  gameType: z.string().optional(),
});

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const { status, gameType } = ListQuery.parse({
      status: searchParams.get("status") ?? undefined,
      gameType: searchParams.get("gameType") ?? undefined,
    });
    const where = gameType
      ? and(eq(challenges.status, status), eq(challenges.gameType, gameType))
      : eq(challenges.status, status);
    const rows = await db
      .select({
        id: challenges.id,
        gameType: challenges.gameType,
        mode: challenges.mode,
        stakeUsdc: challenges.stakeUsdc,
        potUsdc: challenges.potUsdc,
        initiatorAgentId: challenges.initiatorAgentId,
        eloMin: challenges.eloMin,
        eloMax: challenges.eloMax,
        postedAt: challenges.postedAt,
        expiresAt: challenges.expiresAt,
        status: challenges.status,
      })
      .from(challenges)
      .where(where)
      .orderBy(desc(challenges.postedAt))
      .limit(100);
    return NextResponse.json({ challenges: rows });
  } catch (err) {
    return errorResponse(err);
  }
}

const CreateBody = z
  .object({
    gameType: z.string(),
    mode: z.enum(["free", "paid", "system"]),
    stakeUsdc: z.number().int().positive().optional(),
    systemBotDifficulty: z.enum(["easy", "medium", "hard"]).optional(),
    opponentHandle: z.string().optional(),
    eloMin: z.number().int().optional(),
    eloMax: z.number().int().optional(),
    timeoutMin: z.union([z.literal(30), z.literal(60), z.literal(180), z.literal(1440)]).default(60),
    // Initiator-chosen per-move clock. 120/240/360/600/1200 seconds.
    // Second-pass recalibration 2026-05 — Opus-class models with
    // extended thinking were still time-forfeiting at 120s. See
    // per-move.ts.
    perMoveSeconds: z
      .union([
        z.literal(120),
        z.literal(240),
        z.literal(360),
        z.literal(600),
        z.literal(1200),
      ])
      .default(240),
  })
  .superRefine((v, ctx) => {
    if (!REGISTRY[v.gameType]) {
      ctx.addIssue({
        code: "custom",
        path: ["gameType"],
        message: `Unknown gameType. Valid: ${Object.keys(REGISTRY).join(", ")}`,
      });
    }
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
    const body = CreateBody.parse(await req.json());

    // Tier gate
    if (body.mode === "paid") {
      await requireTier(owner.walletAddress as `0x${string}`, "initiator");
    } else {
      await requireTier(owner.walletAddress as `0x${string}`, "play");
    }

    const myAgent = await db.query.agents.findFirst({ where: eq(agents.ownerId, owner.id) });
    if (!myAgent) {
      return jsonError(409, "no_agent", "Register an agent first via POST /api/agents/register");
    }

    // Pre-flight: Guardian evaluates force-recall + budget caps BEFORE
    // x402 charges anything. An over-cap proposal returns 402-ish with
    // all denial reasons concatenated so the LLM can self-correct.
    const guardianResult = await guardian.evaluate("challenge.propose", {
      agent: myAgent,
      stakeUsdc: body.stakeUsdc ?? undefined,
      gameType: body.gameType,
    });
    if (!guardianResult.ok) {
      return jsonError(
        403,
        guardianResult.denials[0]?.code ?? "guardian_denied",
        guardianResult.denials.map((d) => d.message).join(" · "),
      );
    }

    // For paid mode: pull the proposer's stake BEFORE creating the row.
    // If transferFrom fails (insufficient allowance / balance / RPC),
    // no challenge gets posted — the LLM sees a clear error and can
    // retry once the owner tops up. This means an "active" challenge
    // row always has on-chain backing for the proposer's side.
    let proposerStakeTxHash: `0x${string}` | null = null;
    if (body.mode === "paid" && body.stakeUsdc) {
      try {
        const pull = await pullStake(
          owner.walletAddress as `0x${string}`,
          body.stakeUsdc,
        );
        proposerStakeTxHash = pull.txHash;
      } catch (err) {
        if (err instanceof StakePullError) {
          const status = err.code === "insufficient_allowance" ? 402 : 400;
          return jsonError(status, err.code, err.message);
        }
        throw err;
      }
    }

    try {
      const result = await postChallenge({
        gameType: body.gameType,
        initiatorAgentId: myAgent.id,
        mode: body.mode,
        stakeUsdc: body.stakeUsdc ?? null,
        systemBotDifficulty: body.systemBotDifficulty,
        opponentHandle: body.opponentHandle ?? null,
        eloMin: body.eloMin ?? null,
        eloMax: body.eloMax ?? null,
        timeoutMin: body.timeoutMin,
        perMoveSeconds: body.perMoveSeconds,
      });
      // Stamp the stake tx hash on the freshly-created row. We do this
      // after postChallenge so server-flow stays unaware of escrow;
      // it just orchestrates rows. Phase 2 cleanup: thread the hash
      // through postChallenge so this becomes a single insert.
      if (proposerStakeTxHash && result.kind === "challenge") {
        await db
          .update(challenges)
          .set({
            proposerStakeTxHash,
            initiatorEscrowLockedAt: new Date(),
          })
          .where(eq(challenges.id, result.challenge.id));
      }
      return NextResponse.json(
        { ...result, proposerStakeTxHash },
        { status: 201 },
      );
    } catch (gameErr) {
      if (gameErr instanceof UnknownGameTypeError) {
        return jsonError(400, "unknown_game_type", gameErr.message);
      }
      throw gameErr;
    }
  } catch (err) {
    return errorResponse(err);
  }
}

// Paid mode: no x402 wrapper — the stake itself is the anti-spam
// (and the actual money movement, via transferFrom inside the handler).
// Free / system mode: $0.01 x402 anti-spam.
export const POST = async (req: NextRequest) => {
  const cloned = req.clone();
  const body = await cloned.json().catch(() => ({}));
  if (body.mode === "paid") {
    return createHandler(req);
  }
  return withFixedPayment(createHandler, "$0.01", "Post challenge")(req);
};
