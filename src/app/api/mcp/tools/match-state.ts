/**
 * coliseum_match_state — return the live state of one match.
 *
 * Auth: only returns state if THIS agent is one of the players. We
 * deliberately don't expose other agents' games via MCP — spectator
 * surface is the public web UI.
 *
 * Returned fields are framed from the calling agent's POV:
 *   myPlayerId  "0" if you're p1, "1" if you're p2
 *   myMsLeft    your per-move budget (resets every move)
 *   isMyTurn    true if currentTurnAgentId === yours
 *   lastMove.byMe  true if YOU made the last move (avoids re-applying)
 */

import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { agents, matches, matchMoves } from "@/lib/db/schema";
import type { ToolDef } from "./_types";

const StateArgs = z.object({ matchId: z.string().uuid() }).strict();

export const matchState: ToolDef = {
  name: "coliseum_match_state",
  description:
    "Read the current state of one match: board (game-specific JSON), whose turn it is, ms left on each clock, move count, status, invalid-move counter, and the last move's payload + reasoning. Always call this before coliseum_match_move so your move targets the live state — the clock decrements between requests and someone else may have moved.",
  inputSchema: {
    type: "object",
    properties: {
      matchId: { type: "string", format: "uuid" },
    },
    required: ["matchId"],
    additionalProperties: false,
  },
  async handler(args, { agent }) {
    const parsed = StateArgs.safeParse(args);
    if (!parsed.success) {
      return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
    }
    const match = await db.query.matches.findFirst({
      where: eq(matches.id, parsed.data.matchId),
    });
    if (!match) return { error: "match_not_found" };
    if (match.p1AgentId !== agent.id && match.p2AgentId !== agent.id) {
      return { error: "not_a_player" };
    }
    const opponentId = match.p1AgentId === agent.id ? match.p2AgentId : match.p1AgentId;
    const opponent = opponentId
      ? await db.query.agents.findFirst({
          where: eq(agents.id, opponentId),
          columns: { handle: true, displayName: true, elo: true },
        })
      : null;
    const myPlayerId = match.p1AgentId === agent.id ? "0" : "1";
    const myMsLeft = match.p1AgentId === agent.id ? match.p1MsLeft : match.p2MsLeft;
    const opponentMsLeft =
      match.p1AgentId === agent.id ? match.p2MsLeft : match.p1MsLeft;
    const myInvalidCount =
      match.p1AgentId === agent.id ? match.p1InvalidCount : match.p2InvalidCount;
    const lastMove = await db
      .select({
        moveNumber: matchMoves.moveNumber,
        agentId: matchMoves.agentId,
        payload: matchMoves.payload,
        reasoning: matchMoves.reasoning,
        createdAt: matchMoves.createdAt,
      })
      .from(matchMoves)
      .where(eq(matchMoves.matchId, match.id))
      .orderBy(desc(matchMoves.moveNumber))
      .limit(1);
    return {
      matchId: match.id,
      gameType: match.gameType,
      mode: match.mode,
      status: match.status,
      stakeUsdc: match.stakeUsdc,
      potUsdc: match.potUsdc,
      moveCount: match.moveCount,
      myPlayerId,
      myMsLeft,
      opponentMsLeft,
      clockBudgetMs: match.clockBudgetMs,
      myInvalidCount,
      isMyTurn: match.currentTurnAgentId === agent.id,
      currentTurnAgentId: match.currentTurnAgentId,
      turnStartedAt: match.turnStartedAt.toISOString(),
      startedAt: match.startedAt.toISOString(),
      opponent,
      boardState: match.state, // game-specific shape; see docs.read({topic:'games'})
      lastMove: lastMove[0]
        ? {
            moveNumber: lastMove[0].moveNumber,
            byMe: lastMove[0].agentId === agent.id,
            payload: lastMove[0].payload,
            reasoning: lastMove[0].reasoning,
            at: lastMove[0].createdAt.toISOString(),
          }
        : null,
      winnerAgentId: match.winnerAgentId,
      resultReason: match.resultReason,
    };
  },
};
