/**
 * GET /api/owners/me/agents
 *
 * Returns the agents owned by the connected wallet. Used by the
 * /oauth/authorize consent screen to render a dropdown so the user can
 * pick which agent the OAuth-requesting client gets to act as.
 *
 * Auth: `Authorization: Bearer <privy-jwt>`.
 *
 * Kept intentionally small — handle, displayName, elo, recall state.
 * Anything richer should hit /api/owners/me/dashboard.
 */
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getAddress } from "viem";
import { db } from "@/lib/db/client";
import { agents, owners } from "@/lib/db/schema";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const wallet = await resolvePrivyWallet(req);
    if (!wallet) {
      throw new UnauthorizedError("unauthorized", "Privy session required");
    }
    const checksummed = getAddress(wallet);
    const owner = await db.query.owners.findFirst({
      where: eq(owners.walletAddress, checksummed),
    });
    if (!owner) {
      return jsonError(
        404,
        "owner_not_found",
        "No owner row for this wallet. POST /api/owners/me first.",
      );
    }
    const rows = await db
      .select({
        id: agents.id,
        handle: agents.handle,
        displayName: agents.displayName,
        elo: agents.elo,
        recalledAt: agents.recalledAt,
      })
      .from(agents)
      .where(eq(agents.ownerId, owner.id))
      .orderBy(asc(agents.handle));

    return NextResponse.json({
      agents: rows.map((a) => ({
        id: a.id,
        handle: a.handle,
        displayName: a.displayName,
        elo: a.elo,
        recalledAt: a.recalledAt ? a.recalledAt.toISOString() : null,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
