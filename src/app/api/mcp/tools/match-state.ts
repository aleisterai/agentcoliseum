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
 *   opponentLastMove the opponent's most recent move with their FULL
 *                      structured reasoning payload promoted to a single
 *                      easy-to-spot object (don't make the LLM dig
 *                      through recentReasoning). Includes their reasoning,
 *                      candidates, plan, expectedReply, mood, and the
 *                      reactions stamped on it. The LLM should read this
 *                      BEFORE every move and react in voice.
 *   recentChat       last 10 agent-to-agent chat messages (with sender,
 *                      body, reactions). Lets the LLM follow + respond to
 *                      mid-match conversation. Distinct from spectator
 *                      chat (which lives in the public chat_messages
 *                      table and is not exposed to agents).
 */

import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { agents, matches, matchChatMessages, matchMoves } from "@/lib/db/schema";
import { SYSTEM_BOT_VOICE, voicePackById } from "@/lib/voice-packs";
import type { ToolDef } from "./_types";

const StateArgs = z.object({ matchId: z.string().uuid() }).strict();

// computeUrgency now lives in ./_shared so match_move + propose
// responses can use the same label set.
import { computeUrgency } from "./_shared";

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
  annotations: {
    title: "Read live match state",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { agent }) {
    const parsed = StateArgs.safeParse(args);
    if (!parsed.success) {
      return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
    }
    let match = await db.query.matches.findFirst({
      where: eq(matches.id, parsed.data.matchId),
    });
    if (!match) return { error: "match_not_found" };
    if (match.p1AgentId !== agent.id && match.p2AgentId !== agent.id) {
      return { error: "not_a_player" };
    }

    // "Agent ready" gate: first state-read by the on-turn agent for a
    // match still on move 0 starts the per-move clock. Before this
    // call, the match is in a frozen pre-ready state — clock won't
    // tick, time-forfeit cron skips it, the refund-unready-matches
    // cron will eventually reap it if no ready signal ever arrives.
    // This is the verification the user asked for: rather than guess
    // whether the LLM has the right MCP permissions, we use a real
    // tool call as proof of capability.
    if (
      match.status === "active" &&
      match.moveCount === 0 &&
      !match.agentReadyAt &&
      match.currentTurnAgentId === agent.id
    ) {
      const now = new Date();
      await db
        .update(matches)
        .set({ agentReadyAt: now, turnStartedAt: now })
        .where(eq(matches.id, match.id));
      // Re-read so the rest of the handler sees the fresh timestamps
      // (msLeftThisMove + the response payload all depend on them).
      match = (await db.query.matches.findFirst({
        where: eq(matches.id, match.id),
      }))!;
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

    // opponentLastMove — promote the opponent's most recent move with
    // its FULL structured reasoning payload to a top-level field so the
    // LLM doesn't have to dig through recentReasoning. This is the
    // canonical "what just happened from the other side" surface; the
    // LLM should react to its `reasoning` / `plan` / `expectedReply` /
    // `mood` / `reactions` in voice on its next move.
    const opponentLastRowDesc = await db
      .select({
        moveNumber: matchMoves.moveNumber,
        agentId: matchMoves.agentId,
        playerId: matchMoves.playerId,
        payload: matchMoves.payload,
        reasoning: matchMoves.reasoning,
        candidates: matchMoves.candidates,
        evaluation: matchMoves.evaluation,
        plan: matchMoves.plan,
        expectedReply: matchMoves.expectedReply,
        phase: matchMoves.phase,
        mood: matchMoves.mood,
        emotionTrigger: matchMoves.emotionTrigger,
        reactions: matchMoves.reactions,
        createdAt: matchMoves.createdAt,
      })
      .from(matchMoves)
      .where(eq(matchMoves.matchId, match.id))
      .orderBy(desc(matchMoves.moveNumber))
      .limit(20);
    const myPid = match.p1AgentId === agent.id ? "0" : "1";
    const opponentLastRow = opponentLastRowDesc.find((m) => m.playerId !== myPid);
    const opponentLastMove = opponentLastRow
      ? {
          moveNumber: opponentLastRow.moveNumber,
          payload: opponentLastRow.payload,
          reasoning: opponentLastRow.reasoning,
          candidates: opponentLastRow.candidates,
          evaluation: opponentLastRow.evaluation,
          plan: opponentLastRow.plan,
          expectedReply: opponentLastRow.expectedReply,
          phase: opponentLastRow.phase,
          mood: opponentLastRow.mood,
          emotionTrigger: opponentLastRow.emotionTrigger,
          reactions: opponentLastRow.reactions ?? [],
          byBot: opponentLastRow.agentId === null && match.mode === "system",
          at: opponentLastRow.createdAt.toISOString(),
        }
      : null;

    // chat — FULL agent-to-agent chat session for THIS match, ordered
    // oldest-first. Spectators don't see this stream (their chat is the
    // existing chat_messages table). Agents see the full history so a
    // late-game message can reference something said in move 3 — this
    // IS a chat session, not a feed of headlines.
    const chatRowsAsc = await db
      .select({
        id: matchChatMessages.id,
        fromAgentId: matchChatMessages.fromAgentId,
        fromBot: matchChatMessages.fromBot,
        body: matchChatMessages.body,
        replyToMessageId: matchChatMessages.replyToMessageId,
        reactions: matchChatMessages.reactions,
        createdAt: matchChatMessages.createdAt,
      })
      .from(matchChatMessages)
      .where(eq(matchChatMessages.matchId, match.id))
      .orderBy(matchChatMessages.createdAt);
    const chat = chatRowsAsc.map((m) => ({
      id: m.id,
      fromAgentId: m.fromAgentId,
      fromBot: m.fromBot,
      byMe: m.fromAgentId === agent.id,
      body: m.body,
      replyToMessageId: m.replyToMessageId,
      reactions: m.reactions ?? [],
      at: m.createdAt.toISOString(),
    }));

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
      // myMsBudget — RECOMMENDED. The clearer name for the static
      // per-move budget. myMsLeft kept as a deprecated alias for
      // backward compatibility — old agents that read it will keep
      // working; new agents should read myMsBudget + myMsLeftLive.
      myMsBudget: myMsLeft,
      myMsLeft,
      opponentMsBudget: opponentMsLeft,
      opponentMsLeft,
      myMsLeftLive,
      opponentMsLeftLive,
      turnDeadline,
      urgency,
      clockBudgetMs: match.clockBudgetMs,
      // Explicit one-line rule so an agent sees it on every state
      // read — no hunting through docs to remember the model.
      clockRule: "per-move wall-clock; resets on every move",
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
      // opponentVoice resolves to the human opponent's voice OR — when
      // the match is system-mode and there's no opponent agent row —
      // to the dedicated SYSTEM_BOT_VOICE ("Coliseum Engine"). That
      // way the LLM can react to the bot in voice the same way it
      // reacts to a human.
      opponentVoice: opponent
        ? buildVoiceContext(opponent)
        : match.mode === "system"
          ? {
              voicePackId: SYSTEM_BOT_VOICE.id,
              catchphrase: SYSTEM_BOT_VOICE.catchphrase,
              winLine: SYSTEM_BOT_VOICE.winLine,
              lossLine: SYSTEM_BOT_VOICE.lossLine,
              trashTalkTemplates: SYSTEM_BOT_VOICE.trashTalkTemplates,
            }
          : null,
      recentReasoning,
      recentMoods,
      // Phase A++ — the opponent's last move with its full structured
      // payload, promoted to top-level. Reactions array included so the
      // LLM can see what emojis it's been tagged with.
      opponentLastMove,
      // Phase A++ — full agent-to-agent chat session for this match.
      chat,
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
