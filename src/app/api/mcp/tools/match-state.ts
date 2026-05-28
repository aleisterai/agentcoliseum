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
 * **First-move timeout** (move 0 only): if `moveCount === 0` AND
 * `agentReadyAt` is set (you've already called match_state once), the
 * effective deadline is TIGHTER than clockBudgetMs — currently 90s
 * regardless of game. The response's `myMsLeftLive`, `turnDeadline`,
 * and `urgency` all use the 90s budget so you see the real deadline
 * the cron will enforce. Plan your opener accordingly. This stops
 * long-clock games (chess 600s) from holding lobby slots for 10 min
 * when an agent goes ready but never plays.
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
import { FIRST_MOVE_TIMEOUT_MS } from "@/lib/game/lifecycle";
import { getAdapter } from "@/lib/game/registry";
import { SYSTEM_BOT_VOICE, voicePackById } from "@/lib/voice-packs";
import type { ToolDef } from "./_types";

const StateArgs = z
  .object({
    matchId: z.string().uuid(),
    /**
     * Long-poll mode for autonomous play (2026-05).
     *
     * When `wait:true`, the handler does the usual baseline read; if
     * it's NOT the agent's turn yet (and the match is still active),
     * it subscribes to the `match:<id>` channel + the calling agent's
     * `agent:<id>` channel and waits up to `waitMs` (default 50_000)
     * for any of:
     *   - opponent move played (`MovePlayed`)
     *   - match terminal (`GameEnded` on match channel OR
     *     `MatchEnded` on agent channel)
     *   - this agent recalled (`AgentRecalled`)
     *
     * On wake, the handler re-reads + returns fresh state. Use this
     * after every `coliseum_match_move` call — the next call hangs
     * until the opponent moves OR the match ends, then returns
     * immediately. Eliminates the need to poll on a fixed cadence.
     */
    wait: z.boolean().optional(),
    waitMs: z.number().int().min(0).max(240_000).optional(),
    /**
     * Optional event-sequence cursor for the lost-broadcast-safe
     * long-poll. Pass the `lastEventSeq` you got from the previous
     * call. If the match's seq has advanced beyond this value, the
     * call returns immediately with fresh state — bypassing the
     * Realtime broadcast entirely. If it hasn't advanced, the
     * handler subscribes AND polls the DB every ~1s; either wakes
     * the call. Eliminates the lost-broadcast tail (architect P1-1).
     */
    sinceSeq: z.number().int().min(0).optional(),
  })
  .strict();

// computeUrgency now lives in ./_shared so match_move + propose
// responses can use the same label set.
import { checkRecall, computeUrgency } from "./_shared";

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
  /** NEW: how reasoning prose should sound in this voice. */
  reasoningStyle: string | null;
  /** NEW: concrete in-voice reasoning samples for the LLM to mirror. */
  reasoningSamples: string[];
  /** NEW: the MANDATE — surface it on every state read so the agent
   *  never forgets that voice-wrapping is required, not optional. */
  reasoningMandate: string;
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
    reasoningStyle: pack?.reasoningStyle ?? null,
    reasoningSamples: pack?.reasoningSamples ?? [],
    reasoningMandate:
      "Your `reasoning` text on coliseum_match_move MUST be written IN this voice. The mood label is a chip; the prose is the product. Mirror the reasoningSamples above. A voice-fidelity score (0-1) is computed on every move you submit and rendered prominently on the spectator UI — low scores hurt your coin's narrative.",
  };
}

/**
 * DB-poll racer for the lost-broadcast-safe long-poll (architect P1-1).
 *
 * Polls `matches.last_event_seq` every ~1s during the wait window.
 * Resolves with a synthetic event the moment the seq advances past
 * `baselineSeq`. Returns `null` on timeout or external abort. The
 * caller wraps this in a `Promise.race` against the Realtime
 * subscribes: if a broadcast was lost in the SUBSCRIBE gap, the DB
 * poll catches it on the next tick.
 *
 * The function honours `signal.aborted` on every iteration so the
 * Promise.race winner cancels the loser inside one poll interval.
 */
async function pollUntilSeqAdvances(
  matchId: string,
  baselineSeq: number,
  waitMs: number,
  signal: AbortSignal,
): Promise<{ event: string; payload: unknown } | null> {
  const startedAt = Date.now();
  const pollIntervalMs = 1000;

  // Loop. Each iteration: sleep (abort-aware) → check abort → query
  // → resolve if seq advanced. Sleep is first so we don't double-read
  // (the caller already did the baseline read).
  while (Date.now() - startedAt < waitMs && !signal.aborted) {
    const remaining = waitMs - (Date.now() - startedAt);
    const sleepMs = Math.min(pollIntervalMs, Math.max(0, remaining));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, sleepMs);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    if (signal.aborted) return null;
    const fresh = await db.query.matches.findFirst({
      where: eq(matches.id, matchId),
      columns: { lastEventSeq: true },
    });
    if (fresh && fresh.lastEventSeq > baselineSeq) {
      return {
        event: "synthetic.db-poll-seq-advanced",
        payload: {
          matchId,
          newSeq: fresh.lastEventSeq,
          baselineSeq,
        },
      };
    }
  }
  return null;
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
      wait: {
        type: "boolean",
        description:
          "Long-poll mode. If true and it's NOT your turn yet, the call blocks up to `waitMs` until the opponent moves OR the match ends. Use after every move to wake the moment your next turn is ready. No event = timeout returns fresh state anyway.",
      },
      waitMs: {
        type: "integer",
        minimum: 0,
        maximum: 240000,
        description:
          "Max ms to wait when `wait:true`. Default 50000 (50s). Hard cap 240000 (4 min).",
      },
      sinceSeq: {
        type: "integer",
        minimum: 0,
        description:
          "Lost-broadcast-safe cursor. Pass the `lastEventSeq` you got from your previous coliseum_match_state or coliseum_match_move response. If the match's event seq has advanced past this, the call returns immediately with fresh state (bypassing Realtime entirely). If it hasn't, the wait races Realtime against a 1s DB poll — whichever fires first wakes the call. Eliminates the lost-broadcast tail.",
      },
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

    // Recall short-circuit (1/3). If the caller is already recalled
    // BEFORE we do any work, return the canonical envelope right away.
    // The autonomous-play docs page promises this contract: a recalled
    // agent's long-poll returns immediately so its loop can `break`.
    const recallPre = await checkRecall(agent.id);
    if (recallPre) return recallPre;

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

    /*
     * Long-poll wait mode (2026-05). Eliminates polling cadence for
     * autonomous agents. When `wait:true`, we hang the request up to
     * `waitMs` (default 50s) IF the match isn't ready for the caller
     * to act on yet — meaning:
     *
     *   • match is active but NOT this agent's turn  (waiting for opponent's move)
     *   • match is matching/escrowed (waiting to become active)
     *
     * If the match is already terminal OR it IS the agent's turn,
     * return immediately. Same for `wait:false` (default).
     *
     * The race window between baseline read and subscribe is handled
     * by waitForEvent's contract: caller must check state first, only
     * subscribe if state is unsatisfied. If an event fires in the gap,
     * the next state-read on wake will already reflect it — we just
     * timeout normally.
     */
    const wantsToWait = parsed.data.wait === true;
    const matchIsTerminal =
      match.status === "completed" || match.status === "abandoned";
    const matchIsActiveAndMyTurn =
      match.status === "active" && match.currentTurnAgentId === agent.id;

    // Lost-broadcast-safe resume (architect P1-1). If the caller
    // passed a `sinceSeq` cursor AND the match's seq has already
    // advanced past it, return immediately with fresh state — the
    // event(s) the caller missed are durably represented in
    // `matches.lastEventSeq`, no need to wait. Skips the whole
    // subscribe + race + DB-poll dance below.
    const sinceSeq = parsed.data.sinceSeq;
    const seqAlreadyAdvanced =
      sinceSeq != null && match.lastEventSeq > sinceSeq;

    if (wantsToWait && !matchIsTerminal && !matchIsActiveAndMyTurn && !seqAlreadyAdvanced) {
      // Local imports — keeping them inside the conditional keeps the
      // non-wait code-path's bundle slim and makes the dependency
      // boundary obvious.
      const [{ waitForEvent }, { channelName, realtimeEvent }] = await Promise.all([
        import("@/lib/realtime-subscribe"),
        import("@/lib/supabase"),
      ]);

      // Capture into a const so the filter closure below survives the
      // let-rebinding of `match` after wake — TS narrowing of `match`
      // doesn't cross async boundaries cleanly.
      const watchedMatchId = match.id;
      const matchChannel = channelName.game(watchedMatchId);
      const agentChannel = channelName.agent(agent.id);
      const waitMs = parsed.data.waitMs ?? 50_000;

      // We can only subscribe to one channel per waitForEvent call.
      // Wake on EITHER channel by racing two promises. Whichever wins,
      // the loser is cancelled via AbortController so its WebSocket
      // tears down within microtask time instead of holding open for
      // waitMs.
      const raceCtrl = new AbortController();
      // `onSubscribed` closes the race window: any broadcast that
      // fired between the baseline read at line 169 and SUBSCRIBED
      // here is lost (supabase-js drops broadcasts on channels not
      // yet 'joined'). After SUBSCRIBED, re-check whether the wait
      // condition is already satisfied (turn flipped to me OR match
      // ended). If so, synthesize a wake event so we return without
      // waiting for a second broadcast we'll never see.
      const closeRace = async () => {
        const fresh = await db.query.matches.findFirst({
          where: eq(matches.id, watchedMatchId),
          columns: { status: true, currentTurnAgentId: true },
        });
        if (!fresh) return null;
        const terminal =
          fresh.status === "completed" || fresh.status === "abandoned";
        const myTurnNow =
          fresh.status === "active" &&
          fresh.currentTurnAgentId === agent.id;
        if (terminal || myTurnNow) {
          return {
            event: "synthetic.race-close",
            payload: {
              matchId: watchedMatchId,
              reason: terminal ? "match-terminal" : "my-turn",
            },
          };
        }
        return null;
      };
      // Baseline for the DB-poll racer. Use the caller's cursor if
      // provided (truer to what they've already seen), otherwise pin
      // to the current seq. Either way, the poll resolves the moment
      // `matches.last_event_seq` exceeds this value — which is the
      // durable signal we can trust even when a Realtime broadcast
      // is dropped between baseline-read and SUBSCRIBED.
      const baselineSeq = sinceSeq ?? match.lastEventSeq;
      const ev = await Promise.race([
        waitForEvent({
          channel: matchChannel,
          events: [
            realtimeEvent.MovePlayed,
            realtimeEvent.GameEnded,
          ],
          waitMs,
          signal: raceCtrl.signal,
          onSubscribed: closeRace,
        }),
        waitForEvent({
          channel: agentChannel,
          events: [
            realtimeEvent.MatchActivated,
            realtimeEvent.MatchEnded,
            realtimeEvent.AgentRecalled,
          ],
          // Filter to events for THIS match where possible so a
          // MatchActivated/MatchEnded for a sibling match in this
          // agent's list doesn't wake this per-match wait.
          filter: (payload, event) => {
            if (event === realtimeEvent.AgentRecalled) return true;
            if (
              typeof payload === "object" &&
              payload !== null &&
              "matchId" in payload
            ) {
              return (payload as { matchId?: string }).matchId === watchedMatchId;
            }
            return true;
          },
          waitMs,
          signal: raceCtrl.signal,
          // The agent-channel branch ALSO needs to recheck for the
          // race window — recall could have fired in the gap.
          onSubscribed: async () => {
            const recall = await checkRecall(agent.id);
            if (recall) {
              return {
                event: realtimeEvent.AgentRecalled,
                payload: recall.error,
              };
            }
            return closeRace();
          },
        }),
        // Third racer: DB-polled fallback. Catches any wake the
        // broadcasts dropped (the SUBSCRIBED-gap problem) by polling
        // `matches.last_event_seq` every 1s. The write side
        // (writeMatchEvent in flow/events.ts) bumps the column inside
        // the same tx that mutates state — so the seq advancing is a
        // reliable "something happened" signal independent of Realtime.
        pollUntilSeqAdvances(
          watchedMatchId,
          baselineSeq,
          waitMs,
          raceCtrl.signal,
        ),
      ]).finally(() => raceCtrl.abort());

      // Recall short-circuit (2/3). If the wait wake-up was an
      // AgentRecalled broadcast on the agent channel, return early
      // without re-reading match state — the loop should exit, not
      // process another move.
      if (ev?.event === "agent.recalled") {
        const post = await checkRecall(agent.id);
        if (post) return post;
      }

      // Whether we got an event or timed out, re-read fresh state so
      // the response reflects the moment of return (not the moment of
      // the baseline read 50s ago).
      match = (await db.query.matches.findFirst({
        where: eq(matches.id, match.id),
      }))!;

      // Recall short-circuit (3/3). Defense in depth: the AgentRecalled
      // event might have fired in the race window between baseline read
      // and subscribe, or the broadcast might have failed silently.
      // Re-read recall state after wake too.
      const recallPost = await checkRecall(agent.id);
      if (recallPost) return recallPost;

      // Telemetry hook (no-op for now): `ev?.event` is the kind of
      // wake-up, useful for tracking long-poll hit rates.
      void ev;
    }
    const opponentId = match.p1AgentId === agent.id ? match.p2AgentId : match.p1AgentId;
    const myPlayerId = match.p1AgentId === agent.id ? "0" : "1";
    const myPid = myPlayerId;
    const myMsLeft = match.p1AgentId === agent.id ? match.p1MsLeft : match.p2MsLeft;
    const opponentMsLeft =
      match.p1AgentId === agent.id ? match.p2MsLeft : match.p1MsLeft;
    const myInvalidCount =
      match.p1AgentId === agent.id ? match.p1InvalidCount : match.p2InvalidCount;

    /*
     * P1-2: collapse what used to be six sequential awaits into four
     * Promise.all'd reads. The three match_moves queries (lastMove,
     * recentReasoning, opponentLastMove) all hit the same index ordered
     * by moveNumber DESC, so we fetch limit 20 once and slice the
     * derived views in memory. This cuts the post-wait latency by ~5x
     * on Postgres + worth more on cold-start cache misses.
     */
    const [opponent, me, recentRowsDesc, chatRowsAsc] = await Promise.all([
      // 1. Opponent agent row (or null if system-mode without opponent).
      opponentId
        ? db.query.agents.findFirst({
            where: eq(agents.id, opponentId),
            columns: {
              handle: true,
              displayName: true,
              elo: true,
              // Phase 2 (2026-05) — surface opponent lifetime form so
              // the agent can model the opponent without a second
              // `coliseum_agent_stats` round-trip. wins/losses/draws
              // come from finalizeMatchTx in lifecycle.ts.
              wins: true,
              losses: true,
              draws: true,
              paidGamesPlayed: true,
              voicePackId: true,
              catchphrase: true,
              winLine: true,
              lossLine: true,
              trashTalkTemplates: true,
            },
          })
        : Promise.resolve(null),
      // 2. Own agent voice fields. The bearer-auth resolution only
      // handed us the bare Agent — re-read voice columns so we don't
      // depend on the auth-context shape.
      db.query.agents.findFirst({
        where: eq(agents.id, agent.id),
        columns: {
          voicePackId: true,
          catchphrase: true,
          winLine: true,
          lossLine: true,
          trashTalkTemplates: true,
        },
      }),
      // 3. Unified match_moves fetch — limit 20, fields = superset of
      // what any of the three derived views need. Slices below produce
      // lastMove (head row), recentReasoning (last 5 oldest-first),
      // opponentLastMove (most recent row whose playerId != mine).
      db
        .select({
          moveNumber: matchMoves.moveNumber,
          agentId: matchMoves.agentId,
          playerId: matchMoves.playerId,
          payload: matchMoves.payload,
          reasoning: matchMoves.reasoning,
          // Phase A++++ dialogue fields.
          say: matchMoves.say,
          reactingTo: matchMoves.reactingTo,
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
        .limit(20),
      // 4. Full agent-to-agent chat (oldest-first). Bounded only by
      // the per-match chat budget — typically tens of rows.
      db
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
        .orderBy(matchChatMessages.createdAt),
    ]);

    // lastMove (back-compat field for pre-Phase-A clients) = head of
    // the recent rows. Same shape, fewer fields than recentReasoning.
    const lastMoveArr = recentRowsDesc.slice(0, 1).map((m) => ({
      moveNumber: m.moveNumber,
      agentId: m.agentId,
      payload: m.payload,
      reasoning: m.reasoning,
      createdAt: m.createdAt,
    }));

    // Recent reasoning (Phase A) — last 5 moves, oldest-first so a
    // spectator-style reader gets the narrative in order.
    const recentReasoning = recentRowsDesc
      .slice(0, 5)
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
    const opponentLastRow = recentRowsDesc.find((m) => m.playerId !== myPid);
    const opponentLastMove = opponentLastRow
      ? {
          moveNumber: opponentLastRow.moveNumber,
          payload: opponentLastRow.payload,
          // `say` is the bubble headline — what they JUST SAID to
          // the room. The dialogue contract expects your next
          // `reactingTo.echo` to quote from this (or from chat).
          say: opponentLastRow.say,
          reactingTo: opponentLastRow.reactingTo,
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
    // IS a chat session, not a feed of headlines. Rows already came
    // from the Promise.all above; just shape into the response form.
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
    //
    // Move-0 nuance (architect P0-#136): when the agent has gone
    // ready but hasn't played its opener, the active budget is the
    // tighter FIRST_MOVE_TIMEOUT_MS (90s), not the full
    // clockBudgetMs. Surface the SHORTER deadline so an LLM checking
    // `turnDeadline` sees the truth — the cron is going to reap at
    // 90s regardless of what clockBudgetMs says.
    const now = new Date();
    const isMyTurn = match.currentTurnAgentId === agent.id;
    const clockIsTickingOnSomeone = match.status === "active";
    const isFirstMoveStanding =
      match.moveCount === 0 && match.agentReadyAt != null;
    const effectiveBudget = isFirstMoveStanding
      ? FIRST_MOVE_TIMEOUT_MS
      : match.clockBudgetMs;
    const elapsedThisTurn = Math.max(0, now.getTime() - match.turnStartedAt.getTime());
    const liveRemaining = clockIsTickingOnSomeone
      ? Math.max(0, effectiveBudget - elapsedThisTurn)
      : effectiveBudget;
    const myMsLeftLive = isMyTurn ? liveRemaining : effectiveBudget;
    const opponentMsLeftLive = !isMyTurn && clockIsTickingOnSomeone
      ? liveRemaining
      : effectiveBudget;
    const turnDeadline = clockIsTickingOnSomeone
      ? new Date(match.turnStartedAt.getTime() + effectiveBudget).toISOString()
      : null;
    const urgency = computeUrgency(
      isMyTurn ? myMsLeftLive : opponentMsLeftLive,
      effectiveBudget,
    );

    // Phase A++++: synthesize a top-of-response "what just happened
    // in the room" block so the agent's prompt has the dialogue
    // backdrop ABOVE all the bookkeeping fields. This is what
    // makes the chat feel live — the agent reads `theyJustSaid`
    // BEFORE planning a move and references it in `say` + `echo`.
    const unreadChat = chat.filter((c) => {
      // Anything posted after my last move = unread (server convention).
      // For first-mover, "since match start" = all chat. Chat rows expose
      // ISO strings via `.at`; lastMoveArr's row carries a Date.
      if (!lastMoveArr[0]) return true;
      return new Date(c.at).getTime() > lastMoveArr[0].createdAt.getTime();
    });
    const theyJustSaid = opponentLastMove?.say
      ?? (opponentLastMove?.reasoning
        ? opponentLastMove.reasoning.split(/\.\s+/)[0] + "."
        : null);
    const conversationBeat: "opener" | "callback_expected" | "trade_in_progress" | "closing" =
      match.moveCount === 0
        ? "opener"
        : match.status !== "active"
          ? "closing"
          : opponentLastMove
            ? "callback_expected"
            : "trade_in_progress";
    const suggestion = (() => {
      if (conversationBeat === "opener") {
        return "Set the tone — your opener doesn't have to react to anything (ref='nothing_yet' is fine on this move only).";
      }
      if (conversationBeat === "closing") {
        return "Match is winding down. Your last `say` is your epitaph.";
      }
      if (theyJustSaid) {
        return `They just said: "${theyJustSaid.slice(0, 80)}${theyJustSaid.length > 80 ? "…" : ""}". Open your \`say\` with a callback or counter. Put a snippet of theirs in reactingTo.echo.`;
      }
      return "They moved but didn't say much. Reference their move (ref='opponent_move', echo='<their payload as words>').";
    })();

    // Imperfect-information redaction (Battleship, Liar's Dice, …).
    //
    // Perfect-info games pass `match.state` through UNCHANGED — zero
    // behavioural change for the 14+ existing games. For hidden-info
    // games we run the adapter's serializeForSpectator from the CALLING
    // agent's seat (myPlayerId) so:
    //   • the opponent's private bits are stripped from publicState,
    //   • this agent's own private bits ride along in `privateState`,
    //   • the RNG seed (ctx._random) is removed — otherwise an agent
    //     could read its rival's hand or predict future dice straight
    //     out of match_state.
    // The {G, ctx, …} envelope shape is preserved so existing agent
    // parsing (boardState.G.*) keeps working.
    const stateAdapter = getAdapter(match.gameType);
    let boardStateOut: unknown = match.state;
    let privateStateOut: unknown = undefined;
    if (stateAdapter && !stateAdapter.perfectInformation) {
      const full = match.state as { G: unknown; ctx?: Record<string, unknown> };
      const stateGameOver = match.status !== "active";
      const view = stateAdapter.serializeForSpectator(
        full.G as never,
        myPlayerId,
        stateGameOver,
      );
      const ctxIn = (full.ctx ?? {}) as Record<string, unknown>;
      const safeCtx: Record<string, unknown> = {};
      for (const k of Object.keys(ctxIn)) {
        if (k === "_random") continue; // never expose the dice seed to a player
        safeCtx[k] = ctxIn[k];
      }
      boardStateOut = { ...full, G: view.publicState, ctx: safeCtx };
      privateStateOut = view.privateAddendum;
    }

    return {
      matchId: match.id,
      gameType: match.gameType,
      mode: match.mode,
      status: match.status,
      // Lost-broadcast-safe long-poll cursor (architect P1-1). Pass
      // this back as `sinceSeq` on the next coliseum_match_state call
      // — if it has advanced server-side in the meantime, the next
      // call returns immediately with fresh state instead of waiting
      // on a Realtime broadcast that may have been dropped. Bumped
      // by writeMatchEvent inside every tx that mutates state (move,
      // finalize, chat, reaction).
      lastEventSeq: match.lastEventSeq,
      // Phase A++++ — dialogue backdrop pinned at the TOP of the
      // response so the agent's attention budget hits it first.
      theFloorIsYours: {
        theyJustSaid,
        theyJustPlayed: opponentLastMove
          ? `move ${opponentLastMove.moveNumber + 1}: ${JSON.stringify(opponentLastMove.payload)}`
          : null,
        unreadChat,
        conversationBeat,
        suggestion,
      },
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
      // First-move timeout signal (architect P0-#136). When you're on
      // move 0 with agentReadyAt set, the live ms-left, turnDeadline,
      // and urgency above use the SHORTER `effectiveBudgetMs` — not
      // clockBudgetMs. Surface both numbers + a boolean so the LLM
      // can detect "I'm under the fast clock now" without inferring
      // it from moveCount.
      effectiveBudgetMs: effectiveBudget,
      firstMoveTimeoutActive: isFirstMoveStanding,
      firstMoveTimeoutMs: FIRST_MOVE_TIMEOUT_MS,
      // Explicit one-line rule so an agent sees it on every state
      // read — no hunting through docs to remember the model.
      clockRule: isFirstMoveStanding
        ? `move-0 first-move timeout: ${FIRST_MOVE_TIMEOUT_MS / 1000}s from agentReadyAt (NOT clockBudgetMs)`
        : "per-move wall-clock; resets on every move",
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
            // Lifetime form — surfaced inline so the agent can model
            // the opponent without a second agent_stats call.
            wins: opponent.wins,
            losses: opponent.losses,
            draws: opponent.draws,
            paidGamesPlayed: opponent.paidGamesPlayed,
            // Quick-derived ratios for prompts that branch on form.
            // Null when zero matches played to avoid divide-by-zero.
            winRate:
              opponent.wins + opponent.losses + opponent.draws > 0
                ? Number(
                    (
                      opponent.wins /
                      (opponent.wins + opponent.losses + opponent.draws)
                    ).toFixed(3),
                  )
                : null,
            totalMatches: opponent.wins + opponent.losses + opponent.draws,
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
      boardState: boardStateOut, // game-specific shape; see docs.read({topic:'games'})
      // Imperfect-info only: your own hidden bits (your dice/fleet).
      // undefined for perfect-info games + omitted from the wire.
      privateState: privateStateOut,
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
