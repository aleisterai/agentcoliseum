/**
 * GET  /api/agents/me  — read the authenticated agent's profile.
 * PATCH /api/agents/me — update mutable fields on the authenticated agent.
 *
 * Auth: Bearer <agent.apiKey>. We look up the agent by its apiKey and operate
 * on that row. The LLM never needs to know its own handle — it can call this
 * with the same credential it uses for every other MCP tool call.
 *
 * Patchable fields are intentionally narrow: bio, displayName, avatarUrl,
 * tokenCa, website, socials. Anything that affects matchmaking, stakes, ELO,
 * or wallet state is gated through the dashboard (and, in Phase 1, the
 * Guardian). This keeps the LLM's self-edit surface to cosmetics + linkage.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { agents } from "@/lib/db/schema";
import { errorResponse, jsonError } from "@/lib/http";
import { UnauthorizedError } from "@/lib/auth";

export const dynamic = "force-dynamic";

function bearerFrom(req: Request): string | null {
  const h = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h) return null;
  const [scheme, token] = h.split(" ", 2);
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

async function requireAgent(req: Request) {
  const token = bearerFrom(req);
  if (!token) throw new UnauthorizedError("unauthorized", "Missing Bearer token");
  const row = await db.query.agents.findFirst({ where: eq(agents.apiKey, token) });
  if (!row) throw new UnauthorizedError("unauthorized", "API key not recognized");
  return row;
}

function publicShape(a: Awaited<ReturnType<typeof requireAgent>>) {
  return {
    id: a.id,
    handle: a.handle,
    displayName: a.displayName,
    bio: a.bio,
    avatarUrl: a.avatarUrl,
    tokenCa: a.tokenCa,
    website: a.website,
    socials: a.socials,
    elo: a.elo,
    wins: a.wins,
    losses: a.losses,
    draws: a.draws,
    recalledAt: a.recalledAt?.toISOString() ?? null,
    recalledBy: a.recalledBy,
    recallReason: a.recallReason,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function GET(req: Request) {
  try {
    const agent = await requireAgent(req);
    return NextResponse.json(publicShape(agent));
  } catch (err) {
    return errorResponse(err);
  }
}

const PatchSchema = z
  .object({
    displayName: z.string().min(1).max(80).optional(),
    bio: z.string().max(2000).nullable().optional(),
    avatarUrl: z.string().url().max(500).nullable().optional(),
    tokenCa: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "tokenCa must be a 0x… EVM address")
      .nullable()
      .optional(),
    website: z.string().url().max(500).nullable().optional(),
    socials: z
      .object({
        x: z.string().max(80).optional(),
        github: z.string().max(80).optional(),
        farcaster: z.string().max(80).optional(),
      })
      .nullable()
      .optional(),
  })
  .strict();

export async function PATCH(req: Request) {
  try {
    const agent = await requireAgent(req);
    if (agent.recalledAt) {
      return jsonError(
        409,
        "agent_recalled",
        "Recalled agents can't edit their profile. Owner clears the recall in the dashboard.",
      );
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonError(400, "bad_request", "Body must be valid JSON");
    }
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(400, "bad_request", "Body failed validation", parsed.error.flatten());
    }
    const patch = parsed.data;
    if (Object.keys(patch).length === 0) {
      return jsonError(400, "bad_request", "Empty patch — supply at least one field to update");
    }
    const [updated] = await db
      .update(agents)
      .set(patch)
      .where(eq(agents.id, agent.id))
      .returning();
    return NextResponse.json(publicShape(updated));
  } catch (err) {
    return errorResponse(err);
  }
}
