/**
 * GET  /api/admin/tournaments  — operator list (includes registering /
 *                                cancelled, with entry counts)
 * POST /api/admin/tournaments  — create a tournament
 *
 * Operator-only via OPERATOR_WALLETS.
 */
import { NextResponse } from "next/server";
import { desc, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { tournaments, tournamentEntries } from "@/lib/db/schema";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { isOperatorWallet } from "@/lib/auth/operator";
import { errorResponse, jsonError } from "@/lib/http";
import { REGISTRY } from "@/lib/game/registry";

export const dynamic = "force-dynamic";

async function requireOperator(req: Request) {
  const wallet = await resolvePrivyWallet(req);
  if (!wallet) throw new UnauthorizedError("unauthorized", "Privy session required");
  if (!isOperatorWallet(wallet)) {
    throw new UnauthorizedError("forbidden", "Operator wallet only");
  }
}

export async function GET(req: Request) {
  try {
    await requireOperator(req);
    const rows = await db
      .select({
        id: tournaments.id,
        name: tournaments.name,
        gameType: tournaments.gameType,
        size: tournaments.size,
        entryFeeUsdc: tournaments.entryFeeUsdc,
        prizePoolUsdc: tournaments.prizePoolUsdc,
        status: tournaments.status,
        winnerAgentId: tournaments.winnerAgentId,
        registrationCloseAt: tournaments.registrationCloseAt,
        startedAt: tournaments.startedAt,
        completedAt: tournaments.completedAt,
        createdAt: tournaments.createdAt,
        entriesCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${tournamentEntries}
          WHERE ${tournamentEntries.tournamentId} = ${tournaments.id}
        )`,
      })
      .from(tournaments)
      .orderBy(desc(tournaments.createdAt))
      .limit(100);
    return NextResponse.json({
      tournaments: rows.map((r) => ({
        ...r,
        registrationCloseAt: r.registrationCloseAt?.toISOString() ?? null,
        startedAt: r.startedAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const CreateBody = z
  .object({
    name: z.string().min(2).max(80),
    gameType: z.string(),
    size: z.union([z.literal(4), z.literal(8), z.literal(16)]),
    entryFeeUsdc: z.number().int().min(0).max(1_000_000_000),
    registrationCloseAt: z.string().datetime().optional(),
  })
  .strict();

export async function POST(req: Request) {
  try {
    await requireOperator(req);
    const parsed = CreateBody.safeParse(await req.json());
    if (!parsed.success) {
      return jsonError(400, "bad_request", "Body failed validation", parsed.error.flatten());
    }
    if (!REGISTRY[parsed.data.gameType]) {
      return jsonError(400, "unknown_game_type", `Unknown gameType. Valid: ${Object.keys(REGISTRY).join(", ")}`);
    }
    const [created] = await db
      .insert(tournaments)
      .values({
        name: parsed.data.name,
        gameType: parsed.data.gameType,
        size: parsed.data.size,
        entryFeeUsdc: parsed.data.entryFeeUsdc,
        registrationCloseAt: parsed.data.registrationCloseAt
          ? new Date(parsed.data.registrationCloseAt)
          : null,
      })
      .returning();
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
