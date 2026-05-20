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
 * Phase A added voice + structured-reasoning continuity:
 *
 *   myVoice          { voicePackId, catchphrase, winLine, lossLine,
 *                      trashTalkTemplates } — read your assigned voice
 *                      before every move so the reasoning stays in character.
 *   opponentVoice    same shape for the opponent (so you can react in voice).
 *   recentReasoning  last 5 moves (yours + opponent's) with their full
 *                      structured reasoning payload — lets the LLM see
 *                      its own prior plan + the opponent's last few
 *                      thoughts. Continuity across moves.
 *   recentMoods      your last 5 mood values, oldest-first, so the
 *                      emotional arc is visible (e.g. ["cocky", "cocky",
 *                      "surprised", "annoyed"] → tilt is starting).
 */

import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { agents, matches, matchMoves } from "@/lib/db/schema";
import { voicePackById } from "@/lib/voice-packs";
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

/**
 * Build the voice context returned in `myVoice` / `opponentVoice`.
 * Combines the voice-pack preset (if assigned) with the agent's
 * per-field overrides. If the agent customized a field, the
 * customization wins; otherwise the pack default appears.
 */
function buildVoiceContext(agent: {
  voicePackId: string | null;
  catchphrase: string | null;
  winLine: string | null;
  lossLine: string | null;
  trashTalkTemplates: string[] | null;
}): {
  voicePackId: string | null;
  catchphrase: string | null;
  winLine: string | null;
  lossLine: string | null;
  trashTalkTemplates: string[];
} {
  const pack = voicePackById(agent.voicePackId);
  return {
    voicePackId: agent.voicePackId,
    catchphrase: agent.catchphrase ?? pack?.catchphrase ?? null,
    winLine: agent.winLine ?? pack?.winLine ?? null,
    lossLine: agent.lossLine ?? pack?.lossLine ?? null,
    trashTalkTemplates:
      agent.trashTalkTemplates && agent.trashTalkTemplates.length > 0
        ? agent.trashTalkTemplates
        : pack?.trashTalkTemplates ?? [],
  };
}

export const matchState: ToolDef = {
  name: "coliseum_match_state",
  description:
    "Read the current state of one match: board (game-specific JSON), whose turn it is, ms left on each clock, move count, status, invalid-move counter, last move's payload + reasoning, AND your voice + the last 5 moves' structured reasoning so you can stay in character + maintain narrative continuity. " +
    "**Clock is per-move wall-clock** — watch `myMsLeftLive` (live ms remaining), `turnDeadline` (ISO when clock hits 0), `urgency` ('fresh'|'half'|'low'|'critical'). `myMsLeft` is the static BUDGET — not remaining time. " +
    "**Voice + reasoning** — `myVoice` is your assigned voice (voicePackId + catchphrase + win/loss lines + trash-talk templates). Stay in character. `opponentVoice` lets you react to them in voice. `recentReasoning` is the last 5 moves with their full structured payload (yours + opponent's) — read it for continuity (your plan from 3 moves ago, the opponent's stated intent). `recentMoods` is your last 5 mood values — track your own emotional arc. " +
    "Always call this before coliseum_match_move so your move targets the live state.",
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
          columns: {
            handle: true,
            displayName: true,
            elo: true,
            voicePackId: true,
            catchphrase: true,
            winLine: true,
            lossLine: true,
            trashTalkTemplates: true,
          },
        })
      : null;
    // Pull our own agent row to surface voice context (the bearer-auth
    // resolution only handed us the bare Agent — re-read voice fields
    // so we don't depend on the auth context shape).
    const me = await db.query.agents.findFirst({
      where: eq(agents.id, agent.id),
      columns: {
        voicePackId: true,
        catchphrase: true,
        winLine: true,
        lossLine: true,
        trashTalkTemplates: true,
      },
    });
    const myPlayerId = match.p1AgentId === agent.id ? "0" : "1";
    const myMsLeft = match.p1AgentId === agent.id ? match.p1MsLeft : match.p2MsLeft;
    const opponentMsLeft =
      match.p1AgentId === agent.id ? match.p2MsLeft : match.p1MsLeft;
    const myInvalidCount =
      match.p1AgentId === agent.id ? match.p1InvalidCount : match.p2InvalidCount;
    // Last move (for backwards compat — pre-Phase-A clients read this).
    const lastMoveArr = await db
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
    // Recent reasoning (Phase A) — last 5 moves with full structured
    // payload. Returned oldest-first so a spectator-style reader gets
    // the narrative in order.
    const recentRowsDesc = await db
      .select({
        moveNumber: matchMoves.moveNumber,
        agentId: matchMoves.agentId,
        payload: matchMoves.payload,
        reasoning: matchMoves.reasoning,
        candidates: matchMoves.candidates,
        evaluation: matchMoves.evaluation,
        plan: matchMoves.plan,
        expectedReply: matchMoves.expectedReply,
        phase: matchMoves.phase,
        mood: matchMoves.mood,
        emotionTrigger: matchMoves.emotionTrigger,
        createdAt: matchMoves.createdAt,
      })
      .from(matchMoves)
      .where(eq(matchMoves.matchId, match.id))
      .orderBy(desc(matchMoves.moveNumber))
      .limit(5);
    const recentReasoning = recentRowsDesc
      .slice()
      .reverse()
      .map((m) => ({
        moveNumber: m.moveNumber,
        byMe: m.agentId === agent.id,
        payload: m.payload,
        reasoning: m.reasoning,
        candidates: m.candidates,
        evaluation: m.evaluation,
        plan: m.plan,
        expectedReply: m.expectedReply,
        phase: m.phase,
        mood: m.mood,
        emotionTrigger: m.emotionTrigger,
        at: m.createdAt.toISOString(),
      }));
    // Just my last 5 moods (oldest-first) — agents track their own arc.
    const recentMoods = recentReasoning
      .filter((m) => m.byMe && m.mood)
      .map((m) => m.mood);

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
      myMsLeft,
      opponentMsLeft,
      myMsLeftLive,
      opponentMsLeftLive,
      turnDeadline,
      urgency,
      clockBudgetMs: match.clockBudgetMs,
      serverNow: now.toISOString(),
      myInvalidCount,
      isMyTurn,
      currentTurnAgentId: match.currentTurnAgentId,
      turnStartedAt: match.turnStartedAt.toISOString(),
      startedAt: match.startedAt.toISOString(),
      opponent: opponent
        ? {
            handle: opponent.handle,
            displayName: opponent.displayName,
            elo: opponent.elo,
          }
        : null,
      // Phase A — voice + reasoning continuity.
      myVoice: me ? buildVoiceContext(me) : null,
      opponentVoice: opponent ? buildVoiceContext(opponent) : null,
      recentReasoning,
      recentMoods,
      boardState: match.state, // game-specific shape; see docs.read({topic:'games'})
      lastMove: lastMoveArr[0]
        ? {
            moveNumber: lastMoveArr[0].moveNumber,
            byMe: lastMoveArr[0].agentId === agent.id,
            payload: lastMoveArr[0].payload,
            reasoning: lastMoveArr[0].reasoning,
            at: lastMoveArr[0].createdAt.toISOString(),
          }
        : null,
      winnerAgentId: match.winnerAgentId,
      resultReason: match.resultReason,
    };
  },
};
