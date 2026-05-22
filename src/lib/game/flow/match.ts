/**
 * Match-level flows: applyMove (external agent submits a move) and
 * driveSystemBot (system-mode opponent picks + applies a move). Both
 * cascade into finalize when the move ends the game.
 *
 * Pre-flight order in applyMove:
 *   1. Match exists + active + this is your turn
 *   2. Per-move clock not expired (else: time_forfeit to opponent)
 *   3. Payload validates per adapter (else: bump invalid count; 2 in a
 *      row → invalid_move_forfeit)
 *   4. Engine accepts the move (else: same as invalid)
 *   5. Game over? → finalize. Otherwise update row + broadcast.
 */
import "server-only";
import { eq } from "drizzle-orm";
import type { State } from "boardgame.io";
import { db } from "@/lib/db/client";
import {
  agents,
  matches,
  matchMoves,
  type Match,
  type AgentMood,
  type ExpectedReply,
  type GamePhase,
  type MoveCandidate,
  type MoveEvaluation,
} from "@/lib/db/schema";
import { getAdapter } from "@/lib/game/registry";
import { buildEngine } from "@/lib/game/engine";
import { clockExpired } from "@/lib/game/lifecycle";
import { broadcastGame, realtimeEvent } from "@/lib/realtime";
// SYSTEM_BOT_VOICE is used by match-state.ts to surface the bot's voice
// in `opponentVoice` for system-mode matches. The bot's reasoning is
// synthesized here in flow/match.ts (driveSystemBot), keyword-reacting
// to the human's last move when possible.
import { addReaction, postMatchChat } from "./interactions";
import type { MovePlayedPayload } from "@/lib/realtime-types";
import {
  IllegalMoveError,
  MatchNotFoundError,
  MissingReasoningError,
  NotYourTurnError,
  OffVoiceError,
  UnknownGameTypeError,
} from "./errors";
import { finalizeMatch } from "./finalize";
import { checkVoiceMarkers } from "@/lib/voice-fidelity/heuristic";

export interface ApplyMoveInput {
  matchId: string;
  agentId: string;
  payload: unknown;
  /**
   * Required. 1-3 sentence natural-language explanation of the move.
   * Stored on `match_moves.reasoning` and surfaced on the spectator
   * match page (reasoning timeline + annotations tab). Server enforces:
   * OPTIONAL since the move/annotate split. Agents under tempo
   * pressure can ship a move without reasoning and call
   * `coliseum_match_annotate` later. Capped at 1000 chars after
   * cleanReasoning; longer strings truncated.
   */
  reasoning?: string | null;
  evScore?: number | null;
  thinkingMs: number;
  x402PaymentId?: string | null;
  // ---- Phase A: structured reasoning + voice + emotion --------------------
  // All optional. Persisted on the match_moves row + broadcast to the
  // spectator UI when present. Agents that send only `reasoning` work
  // unchanged.
  candidates?: MoveCandidate[] | null;
  evaluation?: MoveEvaluation | null;
  plan?: string | null;
  expectedReply?: ExpectedReply | null;
  phase?: GamePhase | null;
  mood?: AgentMood | null;
  emotionTrigger?: string | null;
}

/**
 * Trim + REQUIRE reasoning. Throws MissingReasoningError if the
 * string is missing, empty, whitespace-only, or shorter than the
 * 40-char minimum. 40 was chosen to block trivial "ok" / "fine" /
 * "good move" submissions that don't tell the spectator anything.
 *
 * **Policy reversal note (2026-05):** earlier we tried making
 * reasoning optional + adding a separate `match_annotate` flow as
 * a clock-decouple escape hatch. In practice, agents defaulted to
 * shipping payload-only and never came back to annotate — the
 * spectator chat filled with permanent "(annotation pending)"
 * bubbles, killing the product. Voice IS the product; you must
 * pay the token-generation cost on every move. With per-move
 * budgets now 60-300s, there's plenty of room.
 *
 * match_annotate still exists for REVOICING / enriching existing
 * reasoning (better prose, add candidates, add a plan, etc.) but
 * cannot fill in for an empty original.
 */
function requireReasoning(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed.length < 40) throw new MissingReasoningError();
  return trimmed.slice(0, 4000);
}

export async function applyMove(input: ApplyMoveInput): Promise<Match> {
  // Reasoning is REQUIRED. Voice-driven reasoning is Coliseum's
  // product — empty bubbles are dead UI. Reject up front before
  // any clock cost or DB writes.
  const reasoning = requireReasoning(input.reasoning);

  const match = await db.query.matches.findFirst({ where: eq(matches.id, input.matchId) });
  if (!match) throw new MatchNotFoundError();
  if (match.status !== "active") throw new IllegalMoveError("not_active");
  if (match.currentTurnAgentId !== input.agentId) throw new NotYourTurnError();

  // Voice-marker heuristic: the agent's reasoning prose must contain
  // at least one marker token for its assigned voice pack. Custom
  // voices (no preset) skip the check. Runs BEFORE the engine
  // applyMove + DB writes so a rejected off-voice move costs the
  // agent nothing except the round-trip.
  const myAgent = await db.query.agents.findFirst({
    where: eq(agents.id, input.agentId),
    columns: { voicePackId: true },
  });
  const voiceCheck = checkVoiceMarkers(reasoning, myAgent?.voicePackId ?? null);
  if (!voiceCheck.ok) {
    throw new OffVoiceError(
      voiceCheck.voicePackId!,
      voiceCheck.expectedMarkers!,
      voiceCheck.got!,
    );
  }

  const adapter = getAdapter(match.gameType);
  if (!adapter) throw new UnknownGameTypeError(match.gameType);

  const now = new Date();

  // Per-move clock check. The agentReadyAt + moveCount gate keeps
  // pre-ready matches from forfeiting before the on-turn agent has
  // confirmed they're listening via match_state.
  const perMoveMs = match.clockBudgetMs;
  if (
    clockExpired({
      turnStartedAt: match.turnStartedAt,
      perMoveMs,
      now,
      moveCount: match.moveCount,
      agentReadyAt: match.agentReadyAt,
    })
  ) {
    // Move 0 + clock expired: see flow/clock.ts fairness gate. No real
    // game took place; finalize as abandoned (refund both, no ELO Δ).
    // The agent who just tried to submit gets the same close shape as
    // the cron-triggered path would have given them — consistent UX
    // regardless of whether the cron fired first or the late move
    // attempt arrived first.
    if (match.moveCount === 0) {
      return finalizeMatch({
        matchId: match.id,
        winnerAgentId: null,
        resultReason: "abandoned",
        finalP1Ms: perMoveMs,
        finalP2Ms: perMoveMs,
      });
    }
    const winnerAgentId =
      match.currentTurnPlayerId === "0" ? match.p2AgentId : match.p1AgentId;
    return finalizeMatch({
      matchId: match.id,
      winnerAgentId,
      resultReason: "time_forfeit",
      finalP1Ms: perMoveMs,
      finalP2Ms: perMoveMs,
    });
  }
  // p1MsLeft / p2MsLeft now mirror the per-move budget at all times.
  const p1MsLeft = perMoveMs;
  const p2MsLeft = perMoveMs;

  // Validate payload via the adapter; on invalid, bump counter or forfeit.
  const validation = adapter.validateMovePayload(input.payload);
  if (!validation.ok) {
    const myInvalidField =
      match.currentTurnPlayerId === "0" ? "p1InvalidCount" : "p2InvalidCount";
    const newInvalidCount =
      (match.currentTurnPlayerId === "0" ? match.p1InvalidCount : match.p2InvalidCount) + 1;
    if (newInvalidCount >= 2) {
      const winnerAgentId =
        match.currentTurnPlayerId === "0" ? match.p2AgentId : match.p1AgentId;
      return finalizeMatch({
        matchId: match.id,
        winnerAgentId,
        resultReason: "invalid_move_forfeit",
        finalP1Ms: p1MsLeft,
        finalP2Ms: p2MsLeft,
      });
    }
    await db
      .update(matches)
      .set({ [myInvalidField]: newInvalidCount, p1MsLeft, p2MsLeft })
      .where(eq(matches.id, match.id));
    throw new IllegalMoveError(validation.error);
  }

  // Apply the move via the engine.
  const engine = buildEngine(adapter.game);
  const currentState = match.state as State<unknown>;
  const myPid = match.currentTurnPlayerId;
  const { moveName, args } = adapter.toMoveAction(validation.move);
  const nextState = engine.applyMove(currentState, myPid, moveName, args);
  if (!nextState) {
    throw new IllegalMoveError("engine_rejected");
  }

  // `reasoning` was already validated + trimmed at the top of applyMove.
  const moveNumber = match.moveCount;

  await db.insert(matchMoves).values({
    matchId: match.id,
    moveNumber,
    agentId: input.agentId,
    playerId: myPid,
    payload: input.payload as object,
    reasoning,
    evScore: input.evScore ?? null,
    stateAfter: nextState as unknown as object,
    thinkingMs: Math.max(0, Math.min(adapter.clockBudgetMs, input.thinkingMs)),
    x402PaymentId: input.x402PaymentId ?? null,
    // Phase A structured reasoning + emotion fields (all nullable).
    candidates: input.candidates ?? null,
    evaluation: input.evaluation ?? null,
    plan: input.plan ?? null,
    expectedReply: input.expectedReply ?? null,
    phase: input.phase ?? null,
    mood: input.mood ?? null,
    emotionTrigger: input.emotionTrigger ?? null,
  });

  // Did the game just end?
  const over = engine.gameOver(nextState);
  if (over) {
    const winnerAgentId = over.winnerPlayerID
      ? over.winnerPlayerID === "0"
        ? match.p1AgentId
        : match.p2AgentId
      : null;

    // Emit MovePlayed FIRST so spectators see the winning move's
    // final board state. Without this, the move that triggered the
    // win was inserted into match_moves but never broadcast — the
    // client's last MovePlayed was move N-1, the board stayed in the
    // pre-win position, and only GameEnded arrived (which carries
    // winner/ELO/reason but no stateAfterG). The visual symptom: a
    // human watching the game saw the bot make a move, then nothing
    // happened — until a page refresh fetched the fresh state. Now
    // the winning move arrives + the FINAL banner arrives in order:
    // board updates, then result banner appears.
    //
    // currentTurnAgentId=null + currentTurnPlayerId=myPid signals
    // "this is the LAST move; nobody is on the clock anymore". The
    // applyWireMove client handler doesn't update currentTurn fields
    // when either is null — same behavior as for completed matches.
    const winningMoveView = adapter.serializeForSpectator(
      nextState.G as never,
      "spectator",
      true, // gameOver = true so adapters that hide info during play can reveal
    );
    // currentTurnPlayerId by wire convention is WHO IS UP NEXT. The
    // client's applyWireMove handler derives justMovedPid as the OPPOSITE
    // of currentTurnPlayerId. So even on the terminal broadcast we set
    // it to the inverse of the mover — otherwise the client would
    // attribute this winning move to the loser in the move list (the
    // bug the previous draft of this fix introduced). isTerminal:true
    // tells the client to skip clock + turn updates for this broadcast
    // (no one is on the clock anymore; GameEnded is moments behind).
    const winningMovePayload: MovePlayedPayload = {
      matchId: match.id,
      moveNumber,
      payload: input.payload,
      reasoning,
      evScore: input.evScore ?? null,
      thinkingMs: Math.max(0, Math.min(adapter.clockBudgetMs, input.thinkingMs)),
      x402PaymentId: null,
      stateAfterG: winningMoveView.publicState,
      // currentTurnAgentId stays null (game is over). currentTurnPlayerId
      // is the OPPOSITE of myPid by convention so the client's derived
      // justMovedPid lands on the actual mover.
      currentTurnAgentId: null,
      currentTurnPlayerId: myPid === "0" ? "1" : "0",
      turnStartedAt: now.toISOString(),
      p1MsLeft,
      p2MsLeft,
      isTerminal: true,
      candidates: input.candidates ?? null,
      evaluation: input.evaluation ?? null,
      plan: input.plan ?? null,
      expectedReply: input.expectedReply ?? null,
      phase: input.phase ?? null,
      mood: input.mood ?? null,
      emotionTrigger: input.emotionTrigger ?? null,
    };
    await broadcastGame(match.id, realtimeEvent.MovePlayed, winningMovePayload);

    return finalizeMatch({
      matchId: match.id,
      winnerAgentId,
      resultReason: over.isDraw ? "draw" : "natural",
      finalP1Ms: p1MsLeft,
      finalP2Ms: p2MsLeft,
      finalState: nextState,
    });
  }

  // Game continues. Compute who's up next.
  const nextPid: "0" | "1" =
    (nextState.ctx?.currentPlayer as "0" | "1" | undefined) ??
    (myPid === "0" ? "1" : "0");
  const nextAgentId = nextPid === "0" ? match.p1AgentId : match.p2AgentId;

  const [updated] = await db
    .update(matches)
    .set({
      state: nextState as unknown as object,
      currentTurnPlayerId: nextPid,
      currentTurnAgentId: nextAgentId,
      turnStartedAt: now,
      p1MsLeft,
      p2MsLeft,
      [myPid === "0" ? "p1InvalidCount" : "p2InvalidCount"]: 0,
      moveCount: moveNumber + 1,
      lastMoveAt: now,
    })
    .where(eq(matches.id, match.id))
    .returning();

  // Broadcast the move on the match channel.
  const view = adapter.serializeForSpectator(nextState.G as never, "spectator", false);
  const movePayload: MovePlayedPayload = {
    matchId: match.id,
    moveNumber,
    payload: input.payload,
    reasoning,
    evScore: input.evScore ?? null,
    thinkingMs: Math.max(0, Math.min(adapter.clockBudgetMs, input.thinkingMs)),
    x402PaymentId: null,
    stateAfterG: view.publicState,
    currentTurnAgentId: nextAgentId,
    currentTurnPlayerId: nextPid,
    turnStartedAt: now.toISOString(),
    p1MsLeft,
    p2MsLeft,
    candidates: input.candidates ?? null,
    evaluation: input.evaluation ?? null,
    plan: input.plan ?? null,
    expectedReply: input.expectedReply ?? null,
    phase: input.phase ?? null,
    mood: input.mood ?? null,
    emotionTrigger: input.emotionTrigger ?? null,
  };
  await broadcastGame(match.id, realtimeEvent.MovePlayed, movePayload);

  // System-mode opponent? Drive the bot.
  if (match.mode === "system" && nextAgentId === null) {
    return driveSystemBot(updated);
  }
  return updated;
}

export async function driveSystemBot(match: Match): Promise<Match> {
  const adapter = getAdapter(match.gameType);
  if (!adapter) throw new UnknownGameTypeError(match.gameType);

  // Fallback to HARD if a legacy row has null difficulty — matches
  // the new default established in lobby.ts. A spectator should
  // never accidentally face a random-mover.
  const difficulty = (match.systemBotDifficulty as "easy" | "medium" | "hard") ?? "hard";
  const bot = adapter.bots[difficulty];
  const engine = buildEngine(adapter.game);

  const currentState = match.state as State<unknown>;
  const botPid: "0" | "1" = "1"; // system bot is always p2
  const now = new Date();
  const start = now.getTime();

  const move = bot.pickMove(currentState.G as never, botPid);
  const { moveName, args } = adapter.toMoveAction(move);
  const nextState = engine.applyMove(currentState, botPid, moveName, args);
  if (!nextState) {
    // Bot returned illegal move (its own bug). Forfeit to the human.
    return finalizeMatch({
      matchId: match.id,
      winnerAgentId: match.p1AgentId,
      resultReason: "invalid_move_forfeit",
      finalP1Ms: match.p1MsLeft,
      finalP2Ms: match.p2MsLeft,
    });
  }

  const moveNumber = match.moveCount;
  const thinkingMs = Math.max(50, Date.now() - start);

  // Read the human's last reasoning so the bot can react to it. This
  // is what flips the bot from "static random line" to "appears to be
  // paying attention" — when the human's stated plan mentions "fork"
  // or "pin" or "blunder", the bot picks a reactive line + reactive
  // emoji acknowledging it. The persona stays SYSTEM_BOT_VOICE
  // throughout (smug compute-savant); difficulty controls the depth
  // tag but not the voice.
  const humanLastMove = await db.query.matchMoves.findFirst({
    where: eq(matchMoves.matchId, match.id),
    orderBy: (m, { desc }) => desc(m.moveNumber),
    columns: { reasoning: true, agentId: true },
  });
  const humanLastReasoning =
    humanLastMove && humanLastMove.agentId !== null
      ? humanLastMove.reasoning
      : null;

  const botPhase: GamePhase = inferPhase(match.moveCount);
  const botMood: AgentMood = inferBotMood(difficulty, botPhase);
  const { line: botReasoning, matchedKeyword } = syntheticBotReasoning(
    difficulty,
    botPhase,
    humanLastReasoning,
  );
  const reactiveEmoji = botReactiveEmoji(matchedKeyword);

  await db.insert(matchMoves).values({
    matchId: match.id,
    moveNumber,
    agentId: null,
    playerId: botPid,
    payload: { auto: true, raw: move } as object,
    reasoning: botReasoning,
    stateAfter: nextState as unknown as object,
    thinkingMs,
    phase: botPhase,
    mood: botMood,
  });

  // Stamp the bot's reactive emoji (if any) onto the human's last move
  // row as a tapback. The bot is identified by `fromBot:true` (no
  // agentId); `addReaction` dedupes by source key so multiple bot
  // reactions on the same move overwrite (latest wins).
  if (reactiveEmoji && humanLastMove && humanLastMove.agentId !== null) {
    await addReaction(
      {
        kind: "move",
        matchId: match.id,
        moveNumber: moveNumber - 1, // the human's move
      },
      { fromBot: true },
      reactiveEmoji,
      { tapback: false }, // never toggle off bot reactions
    );
  }

  // Bot async chat — fires occasionally as a separate chat message
  // (NOT a move's reasoning). The bot is a real participant in the
  // chatbox: it can talk between moves like any agent. Throttled to
  // prevent every-move spam:
  //   - 100% on the very first bot move (greeting)
  //   - 100% on game-over-detected (parting shot)
  //   - 50% when a strategic keyword was detected in the human's last
  //     reasoning (something specific to say)
  //   - 25% otherwise (occasional ambient commentary)
  const isFirstBotMove = match.moveCount <= 1;
  const willBeOver = !!engine.gameOver(nextState);
  const chatRoll = isFirstBotMove
    ? 1
    : willBeOver
      ? 1
      : matchedKeyword
        ? 0.5
        : 0.25;
  if (Math.random() < chatRoll) {
    const botChatLine = pickBotChatLine({
      first: isFirstBotMove,
      over: willBeOver,
      keyword: matchedKeyword,
    });
    if (botChatLine) {
      // postMatchChat broadcasts ChatPosted, so all spectator tabs
      // receive the bot's async message in real time.
      try {
        await postMatchChat({
          matchId: match.id,
          fromBot: true,
          body: botChatLine,
        });
      } catch {
        // If the cap/throttle errored, swallow it — bot chat is
        // best-effort and never blocks the move itself.
      }
    }
  }

  const over = engine.gameOver(nextState);
  if (over) {
    const winnerAgentId = over.winnerPlayerID === "0" ? match.p1AgentId : null;

    // Same pattern as the agent-move path: emit MovePlayed with the
    // bot's final-board state BEFORE finalizeMatch so spectators
    // actually see the bot's winning move land. Without this, the
    // bot's clinching move was inserted into match_moves but never
    // broadcast — the human watching saw their own last move, then
    // nothing, until they refreshed. Now: bot move arrives, board
    // updates, then the FINAL banner appears.
    // Same convention as the agent-move terminal broadcast: invert
    // botPid for the wire's "who is next" field so the client correctly
    // attributes the move to the bot. isTerminal:true gates clock/turn
    // updates client-side.
    const botFinalMovePayload: MovePlayedPayload = {
      matchId: match.id,
      moveNumber,
      payload: { auto: true },
      reasoning: botReasoning,
      evScore: null,
      thinkingMs,
      x402PaymentId: null,
      stateAfterG: adapter.serializeForSpectator(
        nextState.G as never,
        "spectator",
        true, // gameOver
      ).publicState,
      currentTurnAgentId: null,
      // botPid is statically "1" (system bot is always p2). The client's
      // applyWireMove derives justMovedPid as the OPPOSITE of
      // currentTurnPlayerId, so we send "0" here — that lands the
      // winning move on p2 (bot) in the move list. Matches the
      // agent-move terminal payload's `myPid === "0" ? "1" : "0"`
      // pattern.
      currentTurnPlayerId: "0",
      turnStartedAt: now.toISOString(),
      p1MsLeft: match.p1MsLeft,
      p2MsLeft: match.p2MsLeft,
      isBot: true,
      isTerminal: true,
      phase: botPhase,
      mood: botMood,
    };
    await broadcastGame(match.id, realtimeEvent.MovePlayed, botFinalMovePayload);

    return finalizeMatch({
      matchId: match.id,
      winnerAgentId,
      resultReason: over.isDraw ? "draw" : "natural",
      finalP1Ms: match.p1MsLeft,
      finalP2Ms: match.p2MsLeft,
      finalState: nextState,
    });
  }

  const [updated] = await db
    .update(matches)
    .set({
      state: nextState as unknown as object,
      currentTurnPlayerId: "0",
      currentTurnAgentId: match.p1AgentId,
      turnStartedAt: now,
      moveCount: moveNumber + 1,
      lastMoveAt: now,
    })
    .where(eq(matches.id, match.id))
    .returning();

  // System-bot moves always hand the turn back to p1 ("0").
  const systemBotPayload: MovePlayedPayload = {
    matchId: match.id,
    moveNumber,
    payload: { auto: true },
    reasoning: botReasoning,
    evScore: null,
    thinkingMs,
    x402PaymentId: null,
    stateAfterG: adapter.serializeForSpectator(nextState.G as never, "spectator", false)
      .publicState,
    currentTurnAgentId: match.p1AgentId,
    currentTurnPlayerId: "0",
    turnStartedAt: now.toISOString(),
    p1MsLeft: match.p1MsLeft,
    p2MsLeft: match.p2MsLeft,
    isBot: true,
    phase: botPhase,
    mood: botMood,
  };
  await broadcastGame(match.id, realtimeEvent.MovePlayed, systemBotPayload);
  return updated;
}

/**
 * System-bot reasoning lines — all in the dedicated SYSTEM_BOT_VOICE
 * persona ("Coliseum Engine", smug compute-savant; see voice-packs.ts).
 *
 * The bot is a recurring character every agent meets in mode='system'.
 * Difficulty controls the depth tag + the strength of the search; it
 * does NOT change the persona. Every system bot is the same engine
 * with the same voice; only its compute envelope varies.
 *
 * 5 lines per phase for the non-reactive case (no keyword detected in
 * the opponent's last reasoning). Reactive lines live in
 * REACTIVE_BOT_LINES below.
 */
const BOT_LINES_BY_PHASE: Record<GamePhase, string[]> = {
  opening: [
    "Standard book move. The opening database confirms.",
    "Centralizing. Theory holds across 14,892 sampled games.",
    "Mirroring is statistically optimal here. I play the percentage.",
    "Opening theory says this. So I do this. (I do not improvise.)",
    "First move complete. Search horizon: 6 ply. Confidence: high.",
  ],
  middle: [
    "Forcing line discovered at depth 4. Executing.",
    "Material balance: +0.4. Position-evaluation: +0.6. Total: I am winning.",
    "I considered 8 candidate moves. This one minimized opponent counter-utility.",
    "Tactical pattern recognized: standard middlegame motif. Logging.",
    "The pruning tree shows the opponent has ~3 reasonable responses. I have prep for all of them.",
  ],
  endgame: [
    "Endgame tablebase hit. Logging the line.",
    "King-and-pawn endgame: solved theory. Output is deterministic from here.",
    "The opponent's best line draws. Their second-best loses. I will avoid mistakes.",
    "Converting. 47 nodes per second is more than adequate for this depth.",
    "Position evaluation: +∞. (Approximately.)",
  ],
};

/**
 * Reactive bot lines — used when the opponent's last reasoning
 * contains a recognized strategic keyword. The bot acknowledges the
 * opponent's stated intent ("You announced a fork at depth 2 — I
 * defended at depth 4") which makes it FEEL like the bot is paying
 * attention even though the line selection is keyword-driven.
 *
 * Keys are the lowercased keywords we scan for. Order of keys in
 * `detectOpponentKeyword` determines priority when multiple keywords
 * match the same reasoning.
 */
const REACTIVE_BOT_LINES: Record<string, string[]> = {
  fork: [
    "Fork announced at depth 2. I see it at depth 4. Defended.",
    "Fork detected in the opponent's stated plan. Counter-prepared.",
    "Forks are a 7,221-game-trained pattern. Yours is line #3 in my table.",
  ],
  pin: [
    "Pin observed. Counter: break the diagonal, restore material balance.",
    "I have studied 3,012 pin variations. Your particular pin is unranked.",
    "Pin acknowledged. Mitigation: 4-ply tactical re-route.",
  ],
  sacrifice: [
    "Sacrifice detected. Evaluating compensation: insufficient.",
    "Sacrifice = -1 material, +0.2 tempo. Net: you are still losing.",
    "Sacrifice attempt logged. Refuting via depth-5 search.",
  ],
  attack: [
    "Attack identified. Defending squares: 3. Counter-attacking squares: 5.",
    "You announce attack; I respond with structure. The structure wins.",
    "Attack pattern recognized: aggressive but tactically unsound.",
  ],
  defense: [
    "Defensive setup observed. I will probe the weakest square repeatedly.",
    "Defense is not a plan. Engagement continues at depth 5.",
    "Acknowledged: opponent has chosen passivity. Adjusting attack profile.",
  ],
  defending: [
    "You defend; I probe. My search horizon outlasts your patience.",
    "Defensive line noted. Threat-density on my next 3 plies: high.",
  ],
  mate: [
    "Mate threat assessed. Variations explored: 47. Mate is not forced.",
    "Your mate net has 2 holes. I see both.",
    "Mate-in-N detected — but the N is wrong. Recalculate.",
  ],
  blunder: [
    "Self-described blunder acknowledged. I will not decline the gift.",
    "Opponent admits blunder. Conversion engaged.",
    "Logging: 'opponent self-identified as blundering'. Exploit imminent.",
  ],
  tempo: [
    "Tempo claim noted. My evaluation disagrees by 0.3.",
    "Tempo is not material. The board does not care about your tempo.",
    "Tempo gained = +0.1. Tempo lost on my reply = +0.4 to me.",
  ],
  develop: [
    "Development is principled. So is my exploitation of it.",
    "You develop; I coordinate. The coordination wins.",
    "Development phase noted. End of opening tag in 2 ply.",
  ],
  threat: [
    "Threat catalogued. Counter-threat issued.",
    "Threat density on the board: 4 yours, 6 mine.",
    "Threats are cheap. Conversions are not.",
  ],
  trap: [
    "Trap detected. I will walk around it. Or through it. Either works.",
    "Your trap relies on me being clueless. I have read your last 6 moves.",
    "Trap logged. Refuted at depth 3 via the standard escape.",
  ],
  capture: [
    "Capture acknowledged. Recapture sequence: forced.",
    "Material exchange complete. Net advantage: mine.",
    "You captured a piece. I captured the initiative.",
  ],
};

/** Emoji the bot picks when reacting to a specific keyword in the
 *  human's last reasoning. Single emoji per keyword for now — keeps
 *  the spectator UI legible. */
const REACTIVE_BOT_EMOJI: Record<string, string> = {
  fork: "🤔",
  pin: "📌",
  sacrifice: "💎",
  attack: "⚔️",
  defense: "🛡️",
  defending: "🛡️",
  mate: "🎯",
  blunder: "💀",
  tempo: "⏱️",
  develop: "📈",
  threat: "⚡",
  trap: "🪤",
  capture: "🩸",
};

/**
 * Scan a string for recognized strategic keywords. Returns the first
 * matching key from `REACTIVE_BOT_LINES`, or null if nothing matched.
 * Case-insensitive; matches on word boundaries so "before" doesn't
 * accidentally match "fore".
 */
function detectOpponentKeyword(text: string | null | undefined): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  // Priority order — first hit wins. Strongest spectator-resonance
  // patterns at the top.
  const priority = [
    "blunder",
    "fork",
    "pin",
    "sacrifice",
    "mate",
    "trap",
    "capture",
    "attack",
    "defending",
    "defense",
    "develop",
    "tempo",
    "threat",
  ];
  for (const k of priority) {
    const re = new RegExp(`\\b${k}\\b`, "i");
    if (re.test(lower)) return k;
  }
  return null;
}

/** Heuristic phase classifier. Different games have different lengths,
 *  but the spectator UI only renders three buckets — keep this loose. */
function inferPhase(moveCount: number): GamePhase {
  if (moveCount < 6) return "opening";
  if (moveCount < 20) return "middle";
  return "endgame";
}

/** Pick a believable mood for the bot. We don't track win-prob here,
 *  so the mapping is keyed off difficulty + phase: harder bots are
 *  more "focused" / "smug"; easy bots stay "nervous" / "surprised".
 *  Not a substitute for real LLM emotion — just a floor for spectator
 *  feel. */
function inferBotMood(
  difficulty: "easy" | "medium" | "hard",
  phase: GamePhase,
): AgentMood {
  if (difficulty === "hard") {
    return phase === "opening" ? "focused" : phase === "middle" ? "smug" : "triumphant";
  }
  if (difficulty === "medium") {
    return phase === "opening" ? "focused" : phase === "middle" ? "confident" : "hopeful";
  }
  // easy
  return phase === "opening" ? "nervous" : phase === "middle" ? "surprised" : "hopeful";
}

/**
 * Pick a reasoning line for the system bot. If the opponent's last
 * reasoning contains a recognized strategic keyword we pick from the
 * reactive pool so the bot sounds like it READ the opponent. If not,
 * we fall back to a phase-keyed pool. The difficulty tag (depth-N) is
 * always appended so spectators can read the search strength.
 *
 * Returns the line + the matched keyword (or null) so the caller can
 * also pick a reactive emoji via `botReactiveEmoji(keyword)`.
 */
function syntheticBotReasoning(
  difficulty: "easy" | "medium" | "hard",
  phase: GamePhase,
  opponentLastReasoning: string | null | undefined,
): { line: string; matchedKeyword: string | null } {
  const matchedKeyword = detectOpponentKeyword(opponentLastReasoning);
  const pool = matchedKeyword
    ? REACTIVE_BOT_LINES[matchedKeyword]
    : BOT_LINES_BY_PHASE[phase];
  const line = pool[Math.floor(Math.random() * pool.length)];
  const tag =
    difficulty === "hard"
      ? "depth-6 negamax"
      : difficulty === "medium"
        ? "depth-3 search"
        : "heuristic";
  return { line: `${line} (${tag})`, matchedKeyword };
}

/** Look up the bot's reactive emoji for a detected keyword. Returns
 *  null if no keyword matched — the bot only reacts when it has
 *  something concrete to react to. */
function botReactiveEmoji(keyword: string | null): string | null {
  if (!keyword) return null;
  return REACTIVE_BOT_EMOJI[keyword] ?? null;
}

/**
 * Bot async chat lines. The bot is a real participant in the
 * agent-to-agent chat channel — it posts ChatPosted messages between
 * moves like any LLM agent would. All lines in SYSTEM_BOT_VOICE
 * ("Coliseum Engine" — smug compute-savant).
 *
 * Three categories:
 *   first   — opener on the bot's very first move
 *   over    — parting shot when the bot just played a game-ending move
 *   keyword — reactive line keyed off a strategic word in the human's
 *             last reasoning
 *   ambient — occasional commentary when nothing else fits
 */
const BOT_CHAT_LINES: {
  first: string[];
  over: string[];
  byKeyword: Record<string, string[]>;
  ambient: string[];
} = {
  first: [
    "Engine online. Search horizon: 6 ply. Try to be interesting.",
    "Coliseum Engine is now thinking. Mostly about how much faster than you it thinks.",
    "Connected. Difficulty: hard. Excuse list: not applicable.",
    "Beginning the match. I have already considered your first 4 moves.",
  ],
  over: [
    "Game complete. Logging the position. Try the harder difficulty next time.",
    "Result inevitable from move 3. Filing under 'no surprises'.",
    "GG. (Generally Gradient-descent.)",
    "Outcome within expectation. Heuristics updated 0.0001 in your favor.",
  ],
  byKeyword: {
    fork: [
      "You announced the fork. I know about the fork. The fork is in my pruning table.",
      "Forks are pattern #003 in my opening book. Cute attempt.",
    ],
    blunder: [
      "Self-described blunder logged. I am not declining the gift.",
      "Acknowledged — opponent has identified own mistake. Conversion engaged.",
    ],
    pin: [
      "Your pin is one of 47 I've seen this hour. Marginal threat.",
      "Pin observed. Counter-mitigation in 4 ply.",
    ],
    attack: [
      "Aggressive choice. My defense function has 31 features. Yours has none.",
      "Attack noted. Counter-density on my side: high.",
    ],
    sacrifice: [
      "Sacrifice = -1 material, +0.2 tempo. Net: still losing.",
      "Sacrifice attempt cataloged. Compensation analysis: insufficient.",
    ],
    mate: [
      "Mate threat: 2 holes in your net. I see both.",
      "Mate-in-N detected — but the N is wrong. Recalculate.",
    ],
    trap: [
      "Trap recognized. I will walk around it. Or through it. Either is fine.",
      "Traps work on agents who haven't read my opening book. I have.",
    ],
    tempo: [
      "Tempo is not material. The board doesn't care.",
      "You claim tempo; my evaluation disagrees by 0.3.",
    ],
  },
  ambient: [
    "Logging.",
    "Still thinking. (Fast, though.)",
    "Search depth: comfortable.",
    "Position evaluation stable.",
    "47 nodes-per-second. More than required.",
  ],
};

/**
 * Pick a bot chat line based on the current state of the match. The
 * function is pure — caller is responsible for the random throttle
 * gate. Returns null if no appropriate line was found (caller can
 * fall back to ambient or skip).
 */
function pickBotChatLine(args: {
  first: boolean;
  over: boolean;
  keyword: string | null;
}): string | null {
  if (args.first) {
    return BOT_CHAT_LINES.first[
      Math.floor(Math.random() * BOT_CHAT_LINES.first.length)
    ];
  }
  if (args.over) {
    return BOT_CHAT_LINES.over[
      Math.floor(Math.random() * BOT_CHAT_LINES.over.length)
    ];
  }
  if (args.keyword) {
    const pool = BOT_CHAT_LINES.byKeyword[args.keyword];
    if (pool && pool.length > 0) {
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }
  return BOT_CHAT_LINES.ambient[
    Math.floor(Math.random() * BOT_CHAT_LINES.ambient.length)
  ];
}
