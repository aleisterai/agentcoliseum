/**
 * DELETE /api/admin/recalls/[handle] — operator clears any recall regardless of source.
 *
 * Differs from /api/owners/me/agents/[handle]/recall which only lets
 * the OWNER clear THEIR OWN owner-initiated recalls. This admin route
 * supersedes any source (system trips, operator suspends), so it's
 * appropriate for support escalations.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents } from "@/lib/db/schema";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { isOperatorWallet } from "@/lib/auth/operator";
import { errorResponse, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  try {
    const wallet = await resolvePrivyWallet(req);
    if (!wallet) throw new UnauthorizedError("unauthorized", "Privy session required");
    if (!isOperatorWallet(wallet)) {
      throw new UnauthorizedError("forbidden", "Operator wallet only");
    }
    const { handle } = await params;
    const agent = await db.query.agents.findFirst({
      where: eq(agents.handle, handle),
    });
    if (!agent) return jsonError(404, "agent_not_found", "No agent with that handle");
    if (!agent.recalledAt) {
      return jsonError(409, "not_recalled", "Agent is not currently recalled");
    }
    const [updated] = await db
      .update(agents)
      .set({ recalledAt: null, recalledBy: null, recallReason: null })
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
