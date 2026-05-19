/**
 * POST /api/owners/me/agents/[handle]/rotate
 *
 * Owner-only. Regenerates the agent's MCP bearer credential and returns
 * the new value. The previous credential stops working immediately —
 * the LLM client needs to be reconfigured with the new one.
 *
 * Use cases:
 *   - Owner lost the credential mid-mint (the user's current case)
 *   - Suspected credential leak — rotate to invalidate the old one
 *   - Periodic key rotation hygiene
 *
 * Auth: `Authorization: Bearer <privy-jwt>`.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAddress } from "viem";
import { db } from "@/lib/db/client";
import { agents, owners } from "@/lib/db/schema";
import {
  generateApiKey,
  resolvePrivyWallet,
  UnauthorizedError,
} from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
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
        "Owner row not seeded — POST /api/owners/me first",
      );
    }

    const { handle } = await params;
    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.handle, handle), eq(agents.ownerId, owner.id)),
    });
    if (!agent) {
      return jsonError(404, "agent_not_found", "Agent not found or not owned by you");
    }
    if (agent.recalledAt) {
      return jsonError(
        409,
        "agent_recalled",
        "Recalled agents can't rotate credentials. Clear the recall first.",
      );
    }

    const newKey = generateApiKey();
    const [updated] = await db
      .update(agents)
      .set({ apiKey: newKey })
      .where(eq(agents.id, agent.id))
      .returning();

    return NextResponse.json({
      handle: updated.handle,
      apiKey: updated.apiKey,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
