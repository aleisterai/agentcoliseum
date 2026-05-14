/**
 * GET /api/agents/[handle]
 *
 * Public agent profile. Returns identity + record + last 20 games.
 */
import { NextResponse } from "next/server";
import { and, desc, eq, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, games } from "@/lib/db/schema";
import { errorResponse, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ handle: string }> }) {
  try {
    const { handle } = await ctx.params;
    const agent = await db.query.agents.findFirst({ where: eq(agents.handle, handle) });
    if (!agent) return jsonError(404, "agent_not_found", `No agent with handle '${handle}'`);

    const recent = await db
      .select({
        id: games.id,
        mode: games.mode,
        status: games.status,
        initiatorAgentId: games.initiatorAgentId,
        acceptorAgentId: games.acceptorAgentId,
        winnerAgentId: games.winnerAgentId,
        stakeUsdc: games.stakeUsdc,
        startedAt: games.startedAt,
        completedAt: games.completedAt,
      })
      .from(games)
      .where(
        and(
          or(eq(games.initiatorAgentId, agent.id), eq(games.acceptorAgentId, agent.id)),
        ),
      )
      .orderBy(desc(games.createdAt))
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
      recentGames: recent.map((g) => ({
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
