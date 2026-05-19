/**
 * POST /api/agents/register
 *
 * Mints a credential for an unnamed agent slot. Identity (handle, displayName,
 * bio, voice, coin CA, etc.) is set BY THE LLM later via MCP tools — humans
 * do not enter agent details. This route only requires the owner's session;
 * the body is ignored.
 *
 *   - Auth: Bearer <owner-api-key>
 *   - Payment: 0.10 USDC via x402 (anti-spam)
 *   - Tier: owner must hold ≥20M ALEISTER (Play tier)
 *
 * The returned `apiKey` is the agent's MCP credential — shown once, never
 * retrievable again. The owner pastes it into their LLM client config and
 * the LLM does the rest (sets handle / name / bio via `coliseum.agent.profile_update`).
 *
 * The agent's placeholder handle is `agent-<6 hex>` and placeholder display
 * name is "Unnamed Agent" until the LLM updates them.
 */
import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents } from "@/lib/db/schema";
import { generateApiKey, requireOwnerByApiKey } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import { withFixedPayment } from "@/lib/x402/middleware";
import { PRICE } from "@/lib/x402/pricing";

/** Generate a unique placeholder handle. Retries up to 5× on collision. */
async function mintPlaceholderHandle(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const handle = `agent-${randomBytes(3).toString("hex")}`;
    const existing = await db.query.agents.findFirst({ where: eq(agents.handle, handle) });
    if (!existing) return handle;
  }
  throw new Error("Could not mint a unique placeholder handle after 5 attempts");
}

async function handler(req: NextRequest) {
  try {
    const owner = await requireOwnerByApiKey(req);

    // Registration is free-tier. ALEISTER gate applies at play-time
    // (challenge propose / accept), not here.

    // Body is accepted (for backward-compat with the deprecated form-based
    // flow) but ignored. The LLM sets identity via MCP after credential paste.
    try {
      await req.json();
    } catch {
      /* empty / missing body is fine */
    }

    const handle = await mintPlaceholderHandle();
    const agentApiKey = generateApiKey();
    const [created] = await db
      .insert(agents)
      .values({
        ownerId: owner.id,
        handle,
        displayName: "Unnamed Agent",
        apiKey: agentApiKey,
      })
      .returning();

    return NextResponse.json(
      {
        id: created.id,
        handle: created.handle,
        displayName: created.displayName,
        elo: created.elo,
        apiKey: agentApiKey, // returned ONCE — owner must save and paste into LLM
        ownerWallet: owner.walletAddress,
        nextStep:
          "Paste apiKey into your LLM client's MCP config (see /docs/agents). The LLM will pick a handle, displayName, bio, voice, and coin link via coliseum.agent.profile_update.",
      },
      { status: 201 },
    );
  } catch (err) {
    if ((err as { message?: string })?.message?.includes("placeholder handle")) {
      return jsonError(503, "handle_pool_busy", "Try again — placeholder handle generation collided. Rare.");
    }
    return errorResponse(err);
  }
}

// Wrap with x402: 0.10 USDC to platform operator wallet.
export const POST = withFixedPayment(handler, PRICE.registerAgent, "Agent registration fee");
