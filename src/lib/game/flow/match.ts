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
import { addReaction } from "./interactions";
import type { MovePlayedPayload } from "@/lib/realtime-types";
import {
  IllegalMoveError,
  MatchNotFoundError,
  MissingReasoningError,
  NotYourTurnError,
  UnknownGameTypeError,
} from "./errors";
import { finalizeMatch } from "./finalize";

export interface ApplyMoveInput {
  matchId: string;
  agentId: string;
  payload: unknown;
  /**
   * Required. 1-3 sentence natural-language explanation of the move.
   * Stored on `match_moves.reasoning` and surfaced on the spectator
   * match page (reasoning timeline + annotations tab). Server enforces:
   * if missing, empty, or whitespace-only the call throws
   * `MissingReasoningError` BEFORE any DB write or clock cost — agents
   * can retry safely. Capped at 1000 chars; longer strings are
   * truncated.
   */
  reasoning: string;
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
 * Trim + sanity-check the reasoning string. Returns the cleaned value
 * on success, throws `MissingReasoningError` if the string is missing,
 * empty, or pure whitespace.
 *
 * Reasoning is mandatory: it's the product (spectators tune in to read
 * the AI's thinking) and it's the audit trail (every move on Coliseum
 * has an attached natural-language explanation). Bots in dev synthesize
 * a short heuristic string; production agents must publish their own.
 */
function requireReasoning(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new MissingReasoningError();
  return trimmed.slice(0, 1000);
}

export async function applyMove(input: ApplyMoveInput): Promise<Match> {
  // Reasoning is mandatory and is checked BEFORE any DB read so a bad
  // submission doesn't burn the clock or DB connections.
  const reasoning = requireReasoning(input.reasoning);

  const match = await db.query.matches.findFirst({ where: eq(matches.id, input.matchId) });
  if (!match) throw new MatchNotFoundError();
  if (match.status !== "active") throw new IllegalMoveError("not_active");
  if (match.currentTurnAgentId !== input.agentId) throw new NotYourTurnError();

  const adapter = getAdapter(match.gameType);
  if (!adapter) throw new UnknownGameTypeError(match.gameType);

  const now = new Date();

  // Per-move clock check.
  const perMoveMs = match.clockBudgetMs;
  if (clockExpired({ turnStartedAt: match.turnStartedAt, perMoveMs, now })) {
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

  const difficulty = (match.systemBotDifficulty as "easy" | "medium" | "hard") ?? "easy";
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

  const over = engine.gameOver(nextState);
  if (over) {
    const winnerAgentId = over.winnerPlayerID === "0" ? match.p1AgentId : null;
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
