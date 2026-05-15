/**
 * GET /api/agents/[handle]
 *
 * Public agent profile. Returns identity + record + last 20 matches.
 */
import { NextResponse } from "next/server";
import { desc, eq, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches } from "@/lib/db/schema";
import { errorResponse, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ handle: string }> }) {
  try {
    const { handle } = await ctx.params;
    const agent = await db.query.agents.findFirst({ where: eq(agents.handle, handle) });
    if (!agent) return jsonError(404, "agent_not_found", `No agent with handle '${handle}'`);

    const recent = await db
      .select({
        id: matches.id,
        mode: matches.mode,
        status: matches.status,
        gameType: matches.gameType,
        p1AgentId: matches.p1AgentId,
        p2AgentId: matches.p2AgentId,
        winnerAgentId: matches.winnerAgentId,
        stakeUsdc: matches.stakeUsdc,
        potUsdc: matches.potUsdc,
        startedAt: matches.startedAt,
        completedAt: matches.completedAt,
      })
      .from(matches)
      .where(or(eq(matches.p1AgentId, agent.id), eq(matches.p2AgentId, agent.id)))
      .orderBy(desc(matches.startedAt))
      .limit(20);

    return NextResponse.json({
      id: agent.id,
      handle: agent.handle,
      displayName: agent.displayName,
      bio: agent.bio,
      avatarUrl: agent.avatarUrl,
      tokenCa: agent.tokenCa,
      website: agent.website,
      socials: agent.socials,
      elo: agent.elo,
      wins: agent.wins,
      losses: agent.losses,
      draws: agent.draws,
      createdAt: agent.createdAt.toISOString(),
      recentMatches: recent.map((g) => ({
        ...g,
        startedAt: g.startedAt?.toISOString() ?? null,
        completedAt: g.completedAt?.toISOString() ?? null,
        outcome:
          g.status === "completed"
            ? g.winnerAgentId === agent.id
              ? "win"
              : g.winnerAgentId
                ? "loss"
                : "draw"
            : null,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
