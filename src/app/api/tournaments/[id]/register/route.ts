/**
 * POST /api/tournaments/[id]/register
 *
 * Owner-side registration via Privy session. Mirrors the MCP path
 * (coliseum.tournament.register); both delegate to the shared
 * registerForTournament() helper in lib/tournament-registration.ts
 * so the Guardian + stake-pull + DB-write semantics can't drift.
 *
 * Body: { agentHandle } — owner can have multiple agents and picks
 * which one to enter.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAddress } from "viem";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { agents, owners } from "@/lib/db/schema";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import {
  registerForTournament,
  RegistrationError,
} from "@/lib/tournament-registration";

export const dynamic = "force-dynamic";

const Body = z.object({ agentHandle: z.string().min(2).max(32) }).strict();

const STATUS_BY_CODE: Record<string, number> = {
  tournament_not_found: 404,
  wrong_status: 409,
  registration_closed: 409,
  tournament_full: 409,
  already_entered: 409,
  guardian_denied: 403,
  insufficient_allowance: 402,
  insufficient_balance: 400,
  transferFrom_reverted: 400,
  rpc_error: 503,
  internal: 500,
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const wallet = await resolvePrivyWallet(req);
    if (!wallet) throw new UnauthorizedError("unauthorized", "Privy session required");
    const checksummed = getAddress(wallet);
    const owner = await db.query.owners.findFirst({
      where: eq(owners.walletAddress, checksummed),
    });
    if (!owner) return jsonError(404, "owner_not_found", "Owner row not seeded");

    const { id } = await params;
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return jsonError(400, "bad_request", "Body failed validation", parsed.error.flatten());
    }
    const agent = await db.query.agents.findFirst({
      where: and(
        eq(agents.handle, parsed.data.agentHandle),
        eq(agents.ownerId, owner.id),
      ),
    });
    if (!agent) {
      return jsonError(404, "agent_not_found", "No such agent owned by you");
    }

    try {
      const result = await registerForTournament({
        tournamentId: id,
        agent,
        ownerWalletAddress: owner.walletAddress as `0x${string}`,
      });
      return NextResponse.json(result, { status: 201 });
    } catch (err) {
      if (err instanceof RegistrationError) {
        return jsonError(STATUS_BY_CODE[err.code] ?? 400, err.code, err.message);
      }
      throw err;
    }
  } catch (err) {
    return errorResponse(err);
  }
}
