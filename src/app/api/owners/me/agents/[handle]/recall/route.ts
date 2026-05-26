/**
 * POST   /api/owners/me/agents/[handle]/recall — pause the agent.
 * DELETE /api/owners/me/agents/[handle]/recall — clear the recall.
 *
 * Owner-only. A recalled agent fails the Guardian's `forceRecallStatus`
 * check, so it can't propose / accept / move / fund until cleared.
 * Recalls have a source: `owner` (this endpoint), `operator` (admin
 * action), or `system` (anomaly trip). This endpoint always writes
 * `owner` for the source — operator/system go through different paths.
 *
 * Auth: `Authorization: Bearer <privy-jwt>`.
 */
import { NextResponse } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { getAddress } from "viem";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { agents, owners } from "@/lib/db/schema";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import { broadcastAgent, realtimeEvent } from "@/lib/realtime";

export const dynamic = "force-dynamic";

const RecallBody = z
  .object({
    reason: z.string().min(1).max(280).optional(),
  })
  .strict();

async function authzAgent(req: Request, handle: string) {
  const wallet = await resolvePrivyWallet(req);
  if (!wallet) {
    throw new UnauthorizedError("unauthorized", "Privy session required");
  }
  const checksummed = getAddress(wallet);
  const owner = await db.query.owners.findFirst({
    where: eq(owners.walletAddress, checksummed),
  });
  if (!owner) {
    return {
      jsonError: jsonError(404, "owner_not_found", "Owner row not seeded — POST /api/owners/me first"),
    };
  }
  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.handle, handle), eq(agents.ownerId, owner.id)),
  });
  if (!agent) {
    return {
      jsonError: jsonError(404, "agent_not_found", "Agent not found or not owned by you"),
    };
  }
  return { agent };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  try {
    const { handle } = await params;
    const result = await authzAgent(req, handle);
    if ("jsonError" in result) return result.jsonError;
    const { agent } = result;
    if (agent.recalledAt) {
      return jsonError(409, "already_recalled", "Agent is already recalled");
    }
    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      // empty body is fine — reason is optional
    }
    const parsed = RecallBody.safeParse(body ?? {});
    if (!parsed.success) {
      return jsonError(400, "bad_request", "Body failed validation", parsed.error.flatten());
    }
    const reason = parsed.data.reason ?? "Paused by owner";
    const [updated] = await db
      .update(agents)
      .set({
        recalledAt: new Date(),
        recalledBy: "owner",
        recallReason: reason,
      })
      .where(and(eq(agents.id, agent.id), isNotNull(agents.id)))
      .returning();
    // Wake any in-flight match_list(wait:true) / match_state(wait:true)
    // so the agent's loop exits via the AGENT_RECALLED envelope.
    // MUST be awaited — per AGE-55, Vercel freezes the function the
    // moment the response is sent, dropping any in-flight `void`
    // promises before they reach Supabase. Same fix applies here:
    // a recalled agent stuck on a 50s long-poll won't get unblocked
    // until the wait times out if this broadcast is voided.
    await broadcastAgent(agent.id, realtimeEvent.AgentRecalled, {
      reason,
      recalledBy: "owner",
    });
    return NextResponse.json({
      handle: updated.handle,
      recalledAt: updated.recalledAt?.toISOString() ?? null,
      recalledBy: updated.recalledBy,
      recallReason: updated.recallReason,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  try {
    const { handle } = await params;
    const result = await authzAgent(req, handle);
    if ("jsonError" in result) return result.jsonError;
    const { agent } = result;
    if (!agent.recalledAt) {
      return jsonError(409, "not_recalled", "Agent is not currently recalled");
    }
    // Owners can only clear their own owner-initiated recalls. If an operator
    // or the system imposed it, the owner can't unilaterally lift it — they
    // have to escalate through support. This keeps the operator/system tools
    // meaningful (otherwise an owner could pre-emptively clear).
    if (agent.recalledBy !== "owner") {
      return jsonError(
        403,
        "not_owner_recall",
        `This recall was imposed by ${agent.recalledBy} and cannot be cleared by the owner. Contact support.`,
      );
    }
    const [updated] = await db
      .update(agents)
      .set({
        recalledAt: null,
        recalledBy: null,
        recallReason: null,
      })
      .where(eq(agents.id, agent.id))
      .returning();
    return NextResponse.json({
      handle: updated.handle,
      recalledAt: null,
      recalledBy: null,
      recallReason: null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
