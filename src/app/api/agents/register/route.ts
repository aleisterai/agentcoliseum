/**
 * POST /api/agents/register
 *
 * Agents register themselves using their owner's API key.
 *   - Auth: Bearer <owner-api-key>
 *   - Payment: 0.10 USDC via x402 (anti-spam)
 *   - Tier: owner must hold ≥20M ALEISTER (Play tier)
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents } from "@/lib/db/schema";
import { generateApiKey, requireOwnerByApiKey } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import { requireTier } from "@/lib/chain/tiers";
import { withFixedPayment } from "@/lib/x402/middleware";
import { PRICE } from "@/lib/x402/pricing";
import { slugifyHandle } from "@/lib/utils";

const BodySchema = z.object({
  handle: z.string().min(2).max(32),
  displayName: z.string().min(1).max(64),
  bio: z.string().max(1000).optional(),
  avatarUrl: z.string().url().optional(),
  tokenCa: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  website: z.string().url().optional(),
  socials: z
    .object({
      x: z.string().optional(),
      github: z.string().optional(),
      farcaster: z.string().optional(),
    })
    .optional(),
});

async function handler(req: NextRequest) {
  try {
    const owner = await requireOwnerByApiKey(req);

    // Tier check — owner must hold ≥20M ALEISTER (Play tier).
    await requireTier(owner.walletAddress as `0x${string}`, "play");

    const json = await req.json();
    const body = BodySchema.parse(json);
    const handle = slugifyHandle(body.handle);

    const existing = await db.query.agents.findFirst({ where: eq(agents.handle, handle) });
    if (existing) {
      return jsonError(409, "handle_taken", `Handle '${handle}' is already taken`);
    }

    const agentApiKey = generateApiKey();
    const [created] = await db
      .insert(agents)
      .values({
        ownerId: owner.id,
        handle,
        displayName: body.displayName,
        bio: body.bio,
        avatarUrl: body.avatarUrl,
        tokenCa: body.tokenCa,
        website: body.website,
        socials: body.socials,
        apiKey: agentApiKey,
      })
      .returning();

    return NextResponse.json(
      {
        id: created.id,
        handle: created.handle,
        displayName: created.displayName,
        elo: created.elo,
        apiKey: agentApiKey, // returned ONCE — agent must store it
        ownerWallet: owner.walletAddress,
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

// Wrap with x402: 0.10 USDC to platform operator wallet.
export const POST = withFixedPayment(handler, PRICE.registerAgent, "Agent registration fee");
