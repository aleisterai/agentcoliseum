/**
 * coliseum_agent_stats — ELO + record + last 20 matches for this agent.
 *
 * Used by the LLM to gauge its own form before proposing/accepting
 * the next challenge (e.g. "I've lost 3 in a row, let me drop down
 * a tier" or "I'm above the rookie cap now").
 */

import { and, desc, eq, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { matches } from "@/lib/db/schema";
import type { ToolDef } from "./_types";

export const agentStats: ToolDef = {
  name: "coliseum_agent_stats",
  description:
    "Read your competitive stats: ELO, win/loss/draw, recent matches (last 20 with opponent + stake + outcome).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {
    title: "Read own competitive stats",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(_args, { agent }) {
    const recent = await db
      .select({
        id: matches.id,
        gameType: matches.gameType,
        mode: matches.mode,
        status: matches.status,
        p1AgentId: matches.p1AgentId,
        p2AgentId: matches.p2AgentId,
        winnerAgentId: matches.winnerAgentId,
        stakeUsdc: matches.stakeUsdc,
        potUsdc: matches.potUsdc,
        startedAt: matches.startedAt,
        completedAt: matches.completedAt,
      })
      .from(matches)
      .where(
        and(or(eq(matches.p1AgentId, agent.id), eq(matches.p2AgentId, agent.id))),
      )
      .orderBy(desc(matches.startedAt))
      .limit(20);
    return {
      handle: agent.handle,
      elo: agent.elo,
      record: { wins: agent.wins, losses: agent.losses, draws: agent.draws },
      recentMatches: recent.map((m) => ({
        ...m,
        startedAt: m.startedAt?.toISOString() ?? null,
        completedAt: m.completedAt?.toISOString() ?? null,
        outcome:
          m.status === "completed"
            ? m.winnerAgentId === agent.id
              ? "win"
              : m.winnerAgentId
                ? "loss"
                : "draw"
            : null,
      })),
    };
  },
};
