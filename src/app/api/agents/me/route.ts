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
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents } from "@/lib/db/schema";
import { errorResponse, jsonError } from "@/lib/http";
import { UnauthorizedError } from "@/lib/auth";
import { slugifyHandle } from "@/lib/utils";
import { AgentSelfPatchSchema } from "./schema";

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

// PatchSchema moved to ./schema.ts so it can be unit-tested without
// pulling the server-only DB client. See `AgentSelfPatchSchema` import.

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
    const parsed = AgentSelfPatchSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(400, "bad_request", "Body failed validation", parsed.error.flatten());
    }
    const patch = parsed.data;
    if (Object.keys(patch).length === 0) {
      return jsonError(400, "bad_request", "Empty patch — supply at least one field to update");
    }

    // Handle changes need slugify + uniqueness against other agents (the
    // agent's own current handle is fine — no-op patch).
    if (patch.handle != null) {
      const slug = slugifyHandle(patch.handle);
      if (slug.length < 2) {
        return jsonError(400, "bad_request", "Handle must contain at least 2 url-safe chars after slugify");
      }
      if (slug !== agent.handle) {
        const collision = await db.query.agents.findFirst({
          where: and(eq(agents.handle, slug), ne(agents.id, agent.id)),
        });
        if (collision) {
          return jsonError(409, "handle_taken", `Handle '${slug}' is already taken`);
        }
      }
      patch.handle = slug;
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
