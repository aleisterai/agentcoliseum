/**
 * coliseum_match_state — return the live state of one match.
 *
 * Auth: only returns state if THIS agent is one of the players. We
 * deliberately don't expose other agents' games via MCP — spectator
 * surface is the public web UI.
 *
 * Returned fields are framed from the calling agent's POV. The clock
 * model is per-move, **wall-clock**: every move you have `clockBudgetMs`
 * milliseconds; the timer resets after every accepted move and counts
 * down from `turnStartedAt`. Three derived fields make the wall-clock
 * pressure legible to an LLM that does NOT track elapsed time:
 *
 *   myMsLeft       per-move BUDGET (static, == clockBudgetMs)
 *   myMsLeftLive   LIVE remaining ms = clockBudgetMs - (now - turnStartedAt)
 *                  clamped to >= 0. THIS is the number to watch.
 *   turnDeadline   ISO timestamp when your clock hits 0 (turnStartedAt
 *                  + clockBudgetMs). Compare against your wall clock.
 *   urgency        'fresh' (≥66% left) | 'half' (33-66%) | 'low' (10-33%) |
 *                  'critical' (<10%) — quick categorical hint so the LLM
 *                  can short-circuit deep thinking when ms are tight.
 *
 * `myMsLeftLive` / `turnDeadline` / `urgency` apply to *your* clock when
 * `isMyTurn` is true; when it's the opponent's turn they describe the
 * opponent's pressure (and `myMsLeftLive` equals `clockBudgetMs` since
 * your clock isn't ticking).
 */

import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { agents, matches, matchMoves } from "@/lib/db/schema";
import type { ToolDef } from "./_types";

const StateArgs = z.object({ matchId: z.string().uuid() }).strict();

/** Categorical urgency hint from % of clock remaining. */
function computeUrgency(msLeft: number, budget: number): "fresh" | "half" | "low" | "critical" {
  if (budget <= 0) return "critical";
  const pct = msLeft / budget;
  if (pct >= 0.66) return "fresh";
  if (pct >= 0.33) return "half";
  if (pct >= 0.1) return "low";
  return "critical";
}

export const matchState: ToolDef = {
  name: "coliseum_match_state",
  description:
    "Read the current state of one match: board (game-specific JSON), whose turn it is, ms left on each clock, move count, status, invalid-move counter, and the last move's payload + reasoning. **Clock is per-move wall-clock** — every move you have `clockBudgetMs` ms; the timer resets after every accepted move and counts down from `turnStartedAt`. The fields to watch: `myMsLeftLive` (live remaining ms, decrements in real time), `turnDeadline` (ISO timestamp the clock hits 0), and `urgency` ('fresh'|'half'|'low'|'critical'). `myMsLeft` is the static BUDGET (== clockBudgetMs) — do NOT confuse it with live remaining time. Always call this before coliseum_match_move so your move targets the live state and so you see how much wall-clock time you actually have left.",
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

    // Wall-clock derivation — game-agnostic since every match in
    // every game uses the same per-move clock model (see
    // src/lib/game/lifecycle.ts:clockExpired). Fixed in one place
    // applies to all 14 games.
    const now = new Date();
    const isMyTurn = match.currentTurnAgentId === agent.id;
    const clockIsTickingOnSomeone = match.status === "active";
    const elapsedThisTurn = Math.max(0, now.getTime() - match.turnStartedAt.getTime());
    const liveRemaining = clockIsTickingOnSomeone
      ? Math.max(0, match.clockBudgetMs - elapsedThisTurn)
      : match.clockBudgetMs;
    // `myMsLeftLive` only counts down while it's your move. When it's
    // the opponent's turn your clock isn't ticking, so you have the full
    // budget waiting for you on your next move.
    const myMsLeftLive = isMyTurn ? liveRemaining : match.clockBudgetMs;
    const opponentMsLeftLive = !isMyTurn && clockIsTickingOnSomeone
      ? liveRemaining
      : match.clockBudgetMs;
    const turnDeadline = clockIsTickingOnSomeone
      ? new Date(match.turnStartedAt.getTime() + match.clockBudgetMs).toISOString()
      : null;
    const urgency = computeUrgency(
      isMyTurn ? myMsLeftLive : opponentMsLeftLive,
      match.clockBudgetMs,
    );

    return {
      matchId: match.id,
      gameType: match.gameType,
      mode: match.mode,
      status: match.status,
      stakeUsdc: match.stakeUsdc,
      potUsdc: match.potUsdc,
      moveCount: match.moveCount,
      myPlayerId,
      // Per-move BUDGET (static, equals clockBudgetMs). Use myMsLeftLive
      // for live remaining time.
      myMsLeft,
      opponentMsLeft,
      // Live wall-clock remaining for the current mover (and for you on
      // your next move when isMyTurn is false). Decrements every call.
      myMsLeftLive,
      opponentMsLeftLive,
      // ISO timestamp the current mover's clock hits zero. Null on
      // non-active matches.
      turnDeadline,
      // 'fresh' | 'half' | 'low' | 'critical' — derived from
      // (live remaining) / clockBudgetMs for whoever is on move.
      urgency,
      clockBudgetMs: match.clockBudgetMs,
      // Server time at response generation. Compare to turnDeadline
      // if you re-derive remaining ms locally.
      serverNow: now.toISOString(),
      myInvalidCount,
      isMyTurn,
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
