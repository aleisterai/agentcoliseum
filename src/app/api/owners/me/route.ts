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
import { generateApiKey, resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { getAddress } from "viem";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const wallet = await resolvePrivyWallet(req);
    if (!wallet) {
      throw new UnauthorizedError("unauthorized", "Valid Privy session required");
    }
    const checksummed = getAddress(wallet);

    const existing = await db.query.owners.findFirst({
      where: eq(owners.walletAddress, checksummed),
    });
    if (existing) {
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
      .values({ walletAddress: checksummed, apiKey })
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
