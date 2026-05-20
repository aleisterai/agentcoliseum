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
import { matches, matchMoves, type Match } from "@/lib/db/schema";
import { getAdapter } from "@/lib/game/registry";
import { buildEngine } from "@/lib/game/engine";
import { clockExpired } from "@/lib/game/lifecycle";
import { broadcastGame, realtimeEvent } from "@/lib/realtime";
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

  // System-bot moves must publish reasoning too — Coliseum's spectator
  // contract is that every move has a natural-language explanation. The
  // bots don't have LLMs attached, so we synthesize a short heuristic
  // label keyed to difficulty (the depth-N hint signals search strength).
  const botReasoning = syntheticBotReasoning(difficulty);

  await db.insert(matchMoves).values({
    matchId: match.id,
    moveNumber,
    agentId: null,
    playerId: botPid,
    payload: { auto: true, raw: move } as object,
    reasoning: botReasoning,
    stateAfter: nextState as unknown as object,
    thinkingMs,
  });

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
  };
  await broadcastGame(match.id, realtimeEvent.MovePlayed, systemBotPayload);
  return updated;
}

/**
 * Short canned-but-believable reasoning lines for in-app system bots.
 * The bots run minimax / heuristics — there's no LLM to ask for a real
 * explanation — but Coliseum's spectator contract requires reasoning on
 * every move. We surface the difficulty hint so spectators can see that
 * the bot's "thinking" matches its play strength.
 */
const SYNTHETIC_BOT_LINES = [
  "Center control prioritized.",
  "Blocking opponent threat.",
  "Building toward 2-move tactic.",
  "Defending key square.",
  "Pressuring opponent territory.",
  "Maintaining tempo.",
  "Forced response sequence.",
  "Maximizing material balance.",
  "Setting up endgame structure.",
  "Trading favorable position.",
  "Cutting opponent's options.",
  "Activating a piece.",
];

function syntheticBotReasoning(difficulty: "easy" | "medium" | "hard"): string {
  const line =
    SYNTHETIC_BOT_LINES[Math.floor(Math.random() * SYNTHETIC_BOT_LINES.length)];
  const tag =
    difficulty === "hard"
      ? "depth-6 negamax"
      : difficulty === "medium"
        ? "depth-3 search"
        : "heuristic";
  return `${line} (${tag})`;
}
