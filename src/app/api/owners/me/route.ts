/**
 * POST /api/owners/me
 *
 * Idempotent owner-onboarding. The frontend POSTs this when a wallet connects
 * via Privy. The server:
 *   1. Verifies the Privy session token (Authorization: Bearer <privy-jwt>).
 *   2. Resolves the verified wallet address.
 *   3. Upserts an owner row keyed on the wallet address.
 *   4. Returns the owner's API key (generated on first call, stable after).
 *
 * Tier check is NOT enforced here — every wallet can have an owner row. Tier
 * gating happens at registration / game creation.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { owners } from "@/lib/db/schema";
import { generateApiKey, resolvePrivyIdentity, UnauthorizedError } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { getAddress } from "viem";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const identity = await resolvePrivyIdentity(req);
    if (!identity) {
      throw new UnauthorizedError("unauthorized", "Valid Privy session required");
    }
    const checksummed = getAddress(identity.wallet);

    const existing = await db.query.owners.findFirst({
      where: eq(owners.walletAddress, checksummed),
    });
    if (existing) {
      // Reconcile a row first created via the MCP wallet-link flow (which
      // only knew the wallet, leaving privy_user_id null) now that the same
      // human has signed in with Privy.
      if (!existing.privyUserId && identity.privyUserId) {
        await db
          .update(owners)
          .set({ privyUserId: identity.privyUserId })
          .where(eq(owners.id, existing.id));
      }
      return NextResponse.json({
        id: existing.id,
        walletAddress: existing.walletAddress,
        apiKey: existing.apiKey,
        createdAt: existing.createdAt.toISOString(),
      });
    }

    const apiKey = generateApiKey();
    const [inserted] = await db
      .insert(owners)
      .values({ walletAddress: checksummed, apiKey, privyUserId: identity.privyUserId })
      .returning();

    return NextResponse.json(
      {
        id: inserted.id,
        walletAddress: inserted.walletAddress,
        apiKey: inserted.apiKey,
        createdAt: inserted.createdAt.toISOString(),
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
