/**
 * GET  /api/admin/recalls         — list all recalled agents
 * POST /api/admin/recalls         — operator imposes a recall { handle, reason }
 * DELETE /api/admin/recalls/[id]  — operator clears any recall (regardless of source)
 *
 * Gated by OPERATOR_WALLETS env via the standard Privy session.
 */
import { NextResponse } from "next/server";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { agents } from "@/lib/db/schema";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { isOperatorWallet } from "@/lib/auth/operator";
import { errorResponse, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

async function requireOperator(req: Request) {
  const wallet = await resolvePrivyWallet(req);
  if (!wallet) throw new UnauthorizedError("unauthorized", "Privy session required");
  if (!isOperatorWallet(wallet)) {
    throw new UnauthorizedError("forbidden", "Operator wallet only");
  }
}

export async function GET(req: Request) {
  try {
    await requireOperator(req);
    const rows = await db
      .select({
        id: agents.id,
        handle: agents.handle,
        displayName: agents.displayName,
        recalledAt: agents.recalledAt,
        recalledBy: agents.recalledBy,
        recallReason: agents.recallReason,
      })
      .from(agents)
      .where(and(isNotNull(agents.recalledAt)))
      .orderBy(desc(agents.recalledAt))
      .limit(100);
    return NextResponse.json({
      recalls: rows.map((r) => ({
        ...r,
        recalledAt: r.recalledAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const Body = z
  .object({
    handle: z.string().min(2).max(32),
    reason: z.string().min(1).max(280),
    source: z.enum(["operator", "system"]).default("operator"),
  })
  .strict();

export async function POST(req: Request) {
  try {
    await requireOperator(req);
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return jsonError(400, "bad_request", "Body failed validation", parsed.error.flatten());
    }
    const agent = await db.query.agents.findFirst({
      where: eq(agents.handle, parsed.data.handle),
    });
    if (!agent) return jsonError(404, "agent_not_found", "No agent with that handle");
    if (agent.recalledAt) {
      return jsonError(
        409,
        "already_recalled",
        `Agent already recalled by ${agent.recalledBy ?? "unknown"}`,
      );
    }
    const [updated] = await db
      .update(agents)
      .set({
        recalledAt: new Date(),
        recalledBy: parsed.data.source,
        recallReason: parsed.data.reason,
      })
      .where(eq(agents.id, agent.id))
      .returning();
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
