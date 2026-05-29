/**
 * POST /api/owners/me/agents/claim
 *
 * Adopt an ownerless (npx-registered) agent into the signed-in human's
 * account by presenting the agent's `ack_` credential. Binds it ONLY if the
 * agent is currently unowned — see claimOrphanAgent.
 *
 * Auth: `Authorization: Bearer <privy-jwt>`. We resolve the Privy identity to
 * a wallet, find-or-create the owner row (back-filling privyUserId), then
 * claim.
 *
 * Body: { credential: "ack_…" }
 *
 * Note: agents that linked a wallet via MCP are already bound to a
 * wallet-keyed owner — those don't need this; the human just signs in with
 * that same wallet. This route is the path for agents that never linked one.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { db } from "@/lib/db/client";
import { owners } from "@/lib/db/schema";
import { generateApiKey, resolvePrivyIdentity, UnauthorizedError } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import { claimOrphanAgent } from "@/lib/claim-agent";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const identity = await resolvePrivyIdentity(req);
    if (!identity) {
      throw new UnauthorizedError("unauthorized", "Privy session required");
    }
    const checksummed = getAddress(identity.wallet);

    const body = (await req.json().catch(() => ({}))) as { credential?: unknown };
    const credential = typeof body.credential === "string" ? body.credential.trim() : "";
    if (!credential) {
      return jsonError(400, "bad_request", "Provide the agent's credential (ack_…).");
    }

    // Find-or-create the owner row for this wallet, back-filling privyUserId
    // so the row created by an earlier MCP wallet-link gets reconciled.
    let owner = await db.query.owners.findFirst({
      where: eq(owners.walletAddress, checksummed),
    });
    if (!owner) {
      const [created] = await db
        .insert(owners)
        .values({
          walletAddress: checksummed,
          apiKey: generateApiKey(),
          privyUserId: identity.privyUserId,
        })
        .returning();
      owner = created;
    } else if (!owner.privyUserId && identity.privyUserId) {
      await db
        .update(owners)
        .set({ privyUserId: identity.privyUserId })
        .where(eq(owners.id, owner.id));
    }

    const result = await claimOrphanAgent({ ownerId: owner.id, credential });

    switch (result.status) {
      case "claimed":
      case "already_yours":
        return NextResponse.json({
          ok: true,
          status: result.status,
          handle: result.handle,
          displayName: result.displayName,
        });
      case "already_claimed":
        return jsonError(
          409,
          "already_claimed",
          "This agent is already owned by another account. If it's yours, sign in with the wallet it linked.",
        );
      case "invalid_credential":
        return jsonError(
          404,
          "invalid_credential",
          "No agent matches that credential. Paste the exact ack_… key from your npx output or MCP config.",
        );
    }
  } catch (err) {
    return errorResponse(err);
  }
}
