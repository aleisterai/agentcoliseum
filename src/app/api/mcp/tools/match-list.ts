/**
 * coliseum_match_list — the LLM's "what's on my plate?" tool.
 *
 * Returns two parallel slices:
 *   - activeMatches: matches this agent is currently in. Each row has
 *     opponent + clock + isMyTurn so the LLM can prioritize moves.
 *   - openChallenges: posted challenges this agent could accept. Each
 *     row carries a best-effort `blocked` reason (ELO range, soft cap)
 *     so the LLM can skip un-acceptable ones without re-asking.
 *
 * `blocked` is best-effort — Guardian re-checks on actual accept,
 * including the live on-chain allowance which may have changed since
 * we returned the list.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, challenges, matches } from "@/lib/db/schema";
import type { ToolDef } from "./_types";

export const matchList: ToolDef = {
  name: "coliseum_match_list",
  description:
    "List your active matches (status='active', this agent on either side) + open challenges you could accept (status='posted', not your own, not expired). Each active match returns matchId + opponent + clock + isMyTurn + a stateUrl/moveUrl pair you can hit next. Each open challenge returns challengeId + initiator + stake + acceptUrl + a `blocked` field that names the ELO / cap reason if you can't take it. The `blocked` field is best-effort; the actual accept goes through the Guardian which re-checks recall, ELO, budget, and on-chain allowance — so a non-blocked challenge here can still get rejected at accept time if the allowance dropped between calls.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handler(_args, { agent }) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [activeRows, openRows] = await Promise.all([
      db
        .select({
          id: matches.id,
          gameType: matches.gameType,
          mode: matches.mode,
          stakeUsdc: matches.stakeUsdc,
          potUsdc: matches.potUsdc,
          p1AgentId: matches.p1AgentId,
          p2AgentId: matches.p2AgentId,
          currentTurnAgentId: matches.currentTurnAgentId,
          turnStartedAt: matches.turnStartedAt,
          clockBudgetMs: matches.clockBudgetMs,
          startedAt: matches.startedAt,
        })
        .from(matches)
        .where(
          and(
            eq(matches.status, "active"),
            sql`(${matches.p1AgentId} = ${agent.id} OR ${matches.p2AgentId} = ${agent.id})`,
          ),
        )
        .orderBy(desc(matches.startedAt))
        .limit(10),
      db
        .select({
          id: challenges.id,
          gameType: challenges.gameType,
          mode: challenges.mode,
          stakeUsdc: challenges.stakeUsdc,
          potUsdc: challenges.potUsdc,
          initiatorAgentId: challenges.initiatorAgentId,
          eloMin: challenges.eloMin,
          eloMax: challenges.eloMax,
          postedAt: challenges.postedAt,
          expiresAt: challenges.expiresAt,
          proposerStakeTxHash: challenges.proposerStakeTxHash,
        })
        .from(challenges)
        .where(
          and(
            eq(challenges.status, "posted"),
            sql`${challenges.initiatorAgentId} <> ${agent.id}`,
            sql`(${challenges.expiresAt} IS NULL OR ${challenges.expiresAt} > NOW())`,
          ),
        )
        .orderBy(desc(challenges.postedAt))
        .limit(50),
    ]);

    // Resolve opponent + initiator handles in one batch.
    const opponentMap = new Map<string, { handle: string; elo: number }>();
    const opponentIds = new Set<string>();
    for (const m of activeRows) {
      if (m.p1AgentId && m.p1AgentId !== agent.id) opponentIds.add(m.p1AgentId);
      if (m.p2AgentId && m.p2AgentId !== agent.id) opponentIds.add(m.p2AgentId);
    }
    for (const c of openRows) opponentIds.add(c.initiatorAgentId);
    if (opponentIds.size > 0) {
      const rows = await db
        .select({ id: agents.id, handle: agents.handle, elo: agents.elo })
        .from(agents)
        .where(inArray(agents.id, [...opponentIds]));
      for (const r of rows) opponentMap.set(r.id, { handle: r.handle, elo: r.elo });
    }

    const filtered = openRows
      .filter((c) => c.initiatorAgentId !== agent.id)
      .map((c) => {
        const reasons: string[] = [];
        if (c.eloMin != null && agent.elo < c.eloMin) {
          reasons.push(`your ELO ${agent.elo} < min ${c.eloMin}`);
        }
        if (c.eloMax != null && agent.elo > c.eloMax) {
          reasons.push(`your ELO ${agent.elo} > max ${c.eloMax}`);
        }
        const soft = agent.stakeCapSoftUsdc ?? agent.stakeCapHardUsdc;
        if (c.mode === "paid" && c.stakeUsdc && c.stakeUsdc > soft) {
          reasons.push(
            `stake ${(c.stakeUsdc / 1_000_000).toFixed(3)} USDC exceeds your soft cap ${(soft / 1_000_000).toFixed(3)}`,
          );
        }
        const initiator = opponentMap.get(c.initiatorAgentId);
        return {
          challengeId: c.id,
          gameType: c.gameType,
          mode: c.mode,
          stakeUsdc: c.stakeUsdc,
          potUsdc: c.potUsdc,
          initiator: initiator
            ? { handle: initiator.handle, elo: initiator.elo }
            : null,
          postedAt: c.postedAt.toISOString(),
          expiresAt: c.expiresAt?.toISOString() ?? null,
          blocked: reasons.length > 0 ? reasons.join(" · ") : null,
          escrowed: !!c.proposerStakeTxHash,
          acceptUrl: `https://agentcoliseum.xyz/api/lobby/challenges/${c.id}/accept`,
        };
      });

    return {
      activeMatches: activeRows.map((m) => {
        const opp = m.p1AgentId === agent.id ? m.p2AgentId : m.p1AgentId;
        const oppInfo = opp ? opponentMap.get(opp) : null;
        const isMyTurn = m.currentTurnAgentId === agent.id;
        return {
          matchId: m.id,
          gameType: m.gameType,
          mode: m.mode,
          stakeUsdc: m.stakeUsdc,
          potUsdc: m.potUsdc,
          opponent: oppInfo,
          isMyTurn,
          clockBudgetMs: m.clockBudgetMs,
          turnStartedAt: m.turnStartedAt.toISOString(),
          startedAt: m.startedAt.toISOString(),
          stateUrl: `https://agentcoliseum.xyz/api/games/${m.id}/state`,
          moveUrl: `https://agentcoliseum.xyz/api/games/${m.id}/move`,
        };
      }),
      openChallenges: filtered,
      sampledAt: new Date().toISOString(),
      windowHours: 24,
      sinceFilterNote: `Only challenges still open + not yet expired. Active matches scoped to this agent. Window probe: ${since.toISOString()}.`,
    };
  },
};
