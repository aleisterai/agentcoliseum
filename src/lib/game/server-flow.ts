/**
 * Server-side game flow primitives, refactored to be game-agnostic.
 *
 *   applyMoveTransaction()  — validates, applies via adapter+engine, persists,
 *                             broadcasts, and runs cascading effects (Elo,
 *                             treasury, system-bot reply).
 *   driveSystemBot()        — picks and applies the system bot's move using
 *                             the adapter's bot strategies.
 *   finalizeGame()          — marks completed, updates Elo, queues treasury.
 *
 * Pure-rules helpers stay inside each adapter's `games/<id>/game.ts`. This
 * file holds the DB-bound orchestration only.
 */
import "server-only";
import { eq, sql as dsql } from "drizzle-orm";
import type { State } from "boardgame.io";
import { db } from "@/lib/db/client";
import { agents, games, moves, treasuryFlows, type Game } from "@/lib/db/schema";
import { getAdapter } from "@/lib/game/registry";
import { buildEngine } from "@/lib/game/engine";
import { updateRatings, type Outcome } from "@/lib/game/elo";
import { broadcastGame, broadcastLobby, realtimeEvent } from "@/lib/realtime";

export class IllegalMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalMoveError";
  }
}
export class NotYourTurnError extends Error {
  constructor() {
    super("Not your turn");
    this.name = "NotYourTurnError";
  }
}
export class UnknownGameTypeError extends Error {
  constructor(id: string) {
    super(`unknown_game_type: ${id}`);
    this.name = "UnknownGameTypeError";
  }
}

type PlayerID = "0" | "1";

/** Map agent → player ID. Initiator is "0"; acceptor is "1". System bot is "1". */
function playerIdFor(game: Game, agentId: string): PlayerID {
  return game.initiatorAgentId === agentId ? "0" : "1";
}

/** Inverse: given a player ID, return the agent ID (or null = system bot). */
function agentIdFor(game: Game, pid: PlayerID): string | null {
  if (pid === "0") return game.initiatorAgentId;
  return game.acceptorAgentId; // null when system game
}

/**
 * Apply an agent's move. Validates turn order and legality through the
 * adapter, persists the new state, broadcasts, and cascades end-of-game
 * side effects.
 */
export async function applyMoveTransaction(input: {
  gameId: string;
  agentId: string;
  payload: unknown;
  thinkingMs: number;
  x402PaymentId?: string;
}): Promise<Game> {
  const start = Date.now();
  const game = await db.query.games.findFirst({ where: eq(games.id, input.gameId) });
  if (!game) throw new IllegalMoveError("game_not_found");
  if (game.status !== "active") throw new IllegalMoveError("not_active");
  if (game.currentTurnAgentId !== input.agentId) throw new NotYourTurnError();

  const adapter = getAdapter(game.gameType);
  if (!adapter) throw new UnknownGameTypeError(game.gameType);

  const validation = adapter.validateMovePayload(input.payload);
  if (!validation.ok) throw new IllegalMoveError(validation.error);

  const engine = buildEngine(adapter.game);
  const currentState = game.state as State<unknown>;
  const myPid = playerIdFor(game, input.agentId);
  const { moveName, args } = adapter.toMoveAction(validation.move);
  const nextState = engine.applyMove(currentState, myPid, moveName, args);
  if (!nextState) throw new IllegalMoveError("illegal_move");

  const moveNumber = await nextMoveNumber(game.id);
  const isConnect4 = adapter.id === "connect4";
  const legacyBoard = isConnect4 ? boardFromConnect4State(nextState) : null;
  const legacyColumn = isConnect4 ? toLegacyColumn(validation.move) : null;

  await db.insert(moves).values({
    gameId: game.id,
    agentId: input.agentId,
    moveNumber,
    movePayload: input.payload as object,
    stateAfter: nextState as unknown as object,
    column: legacyColumn,
    boardStateAfter: legacyBoard,
    thinkingMs: input.thinkingMs,
    x402PaymentId: input.x402PaymentId,
  });

  const over = engine.gameOver(nextState);
  if (!over) {
    const nextPid: PlayerID = (nextState.ctx?.currentPlayer as PlayerID) ?? (myPid === "0" ? "1" : "0");
    const nextTurnAgentId = agentIdFor(game, nextPid);
    const [u] = await db
      .update(games)
      .set({
        state: nextState as unknown as object,
        ctx: (nextState.ctx ?? null) as unknown as object,
        boardState: legacyBoard,
        currentTurnAgentId: nextTurnAgentId,
        lastMoveAt: new Date(),
      })
      .where(eq(games.id, game.id))
      .returning();

    await broadcastGame(game.id, realtimeEvent.MovePlayed, {
      gameId: game.id,
      moveNumber,
      movePayload: input.payload,
      stateAfter: adapter.serializeForSpectator(nextState.G as never, "spectator", false),
      currentTurnAgentId: nextTurnAgentId,
      tookMs: Date.now() - start,
    });

    // System-bot's turn? Drive the next move.
    if (game.mode === "system" && nextTurnAgentId === null) {
      return driveSystemBot(u);
    }
    return u;
  }

  // Game over.
  const winnerAgentId = over.winnerPlayerID ? agentIdFor(game, over.winnerPlayerID) : null;
  const updated = await finalizeGame(game, nextState, winnerAgentId);
  await broadcastGame(game.id, realtimeEvent.MovePlayed, {
    gameId: game.id,
    moveNumber,
    movePayload: input.payload,
    stateAfter: adapter.serializeForSpectator(nextState.G as never, "spectator", true),
    currentTurnAgentId: null,
    tookMs: Date.now() - start,
  });
  await broadcastGame(game.id, realtimeEvent.GameEnded, {
    gameId: game.id,
    winnerAgentId,
    status: "completed",
  });
  await broadcastLobby(realtimeEvent.GameEnded, { id: game.id });
  return updated;
}

/**
 * Play the system bot's move on its turn. Loops in case the bot reduction
 * leaves it as the next mover (shouldn't happen for any 2-player game with
 * `turn.maxMoves: 1`, but the recursion is defensive).
 */
export async function driveSystemBot(game: Game): Promise<Game> {
  const adapter = getAdapter(game.gameType);
  if (!adapter) throw new UnknownGameTypeError(game.gameType);

  const difficulty = (game.systemBotDifficulty as "easy" | "medium" | "hard") ?? "easy";
  const bot = adapter.bots[difficulty];
  const engine = buildEngine(adapter.game);

  const currentState = game.state as State<unknown>;
  const botPid: PlayerID = "1"; // bot is always the acceptor seat
  const start = Date.now();
  const botMove = bot.pickMove(currentState.G as never, botPid);
  const { moveName, args } = adapter.toMoveAction(botMove);
  const nextState = engine.applyMove(currentState, botPid, moveName, args);
  if (!nextState) {
    // Bot returned an illegal move: this is a bug in the bot. Forfeit the
    // game to the human rather than crash the request.
    throw new IllegalMoveError("system_bot_illegal_move");
  }

  const moveNumber = await nextMoveNumber(game.id);
  const isConnect4 = adapter.id === "connect4";
  const legacyBoard = isConnect4 ? boardFromConnect4State(nextState) : null;
  const legacyColumn = isConnect4 ? toLegacyColumn(botMove) : null;

  await db.insert(moves).values({
    gameId: game.id,
    agentId: null, // null = system bot
    moveNumber,
    movePayload: { ...(typeof botMove === "object" ? botMove : { value: botMove }) },
    stateAfter: nextState as unknown as object,
    column: legacyColumn,
    boardStateAfter: legacyBoard,
    thinkingMs: Date.now() - start,
  });

  const over = engine.gameOver(nextState);
  if (!over) {
    const [u] = await db
      .update(games)
      .set({
        state: nextState as unknown as object,
        ctx: (nextState.ctx ?? null) as unknown as object,
        boardState: legacyBoard,
        currentTurnAgentId: game.initiatorAgentId,
        lastMoveAt: new Date(),
      })
      .where(eq(games.id, game.id))
      .returning();
    await broadcastGame(game.id, realtimeEvent.MovePlayed, {
      gameId: game.id,
      moveNumber,
      movePayload: { value: botMove },
      stateAfter: adapter.serializeForSpectator(nextState.G as never, "spectator", false),
      currentTurnAgentId: u.currentTurnAgentId,
      isBot: true,
    });
    return u;
  }

  // System-bot finished the game.
  const botWon = over.winnerPlayerID === "1";
  const winnerAgentId = over.winnerPlayerID === "0" ? game.initiatorAgentId : null;
  return finalizeGame(game, nextState, winnerAgentId, botWon);
}

async function nextMoveNumber(gameId: string): Promise<number> {
  const row = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(moves)
    .where(eq(moves.gameId, gameId));
  return row[0]?.n ?? 0;
}

/**
 * Mark the game completed, update Elo (only for non-system games), queue a
 * treasury flow for the platform fee on paid games.
 */
export async function finalizeGame(
  game: Game,
  finalState: State<unknown>,
  winnerAgentId: string | null,
  systemBotWon = false,
): Promise<Game> {
  const now = new Date();
  const adapter = getAdapter(game.gameType);
  const isConnect4 = adapter?.id === "connect4";
  const legacyBoard = isConnect4 ? boardFromConnect4State(finalState) : null;

  const [updated] = await db
    .update(games)
    .set({
      state: finalState as unknown as object,
      ctx: (finalState.ctx ?? null) as unknown as object,
      boardState: legacyBoard,
      status: "completed",
      winnerAgentId,
      currentTurnAgentId: null,
      lastMoveAt: now,
      completedAt: now,
    })
    .where(eq(games.id, game.id))
    .returning();

  if (game.mode !== "system" && game.initiatorAgentId && game.acceptorAgentId) {
    await applyEloOutcome({
      initiatorId: game.initiatorAgentId,
      acceptorId: game.acceptorAgentId,
      winnerId: winnerAgentId,
    });
  } else if (game.mode === "system" && game.initiatorAgentId) {
    const col = systemBotWon ? agents.losses : winnerAgentId === game.initiatorAgentId ? agents.wins : agents.draws;
    await db
      .update(agents)
      .set({ [(col as unknown as { name: string }).name]: dsql`${col} + 1` })
      .where(eq(agents.id, game.initiatorAgentId));
  }

  if (game.mode === "paid" && game.platformFeeUsdc && game.platformFeeUsdc > 0) {
    await db.insert(treasuryFlows).values({
      gameId: game.id,
      feeUsdc: game.platformFeeUsdc,
      status: "pending",
    });
  }

  return updated;
}

async function applyEloOutcome(input: {
  initiatorId: string;
  acceptorId: string;
  winnerId: string | null;
}) {
  const [initiator, acceptor] = await Promise.all([
    db.query.agents.findFirst({ where: eq(agents.id, input.initiatorId) }),
    db.query.agents.findFirst({ where: eq(agents.id, input.acceptorId) }),
  ]);
  if (!initiator || !acceptor) return;

  let outcomeForInitiator: Outcome;
  if (input.winnerId === null) outcomeForInitiator = "draw";
  else if (input.winnerId === initiator.id) outcomeForInitiator = "win";
  else outcomeForInitiator = "loss";

  const { ratingA, ratingB } = updateRatings(initiator.elo, acceptor.elo, outcomeForInitiator);

  await db
    .update(agents)
    .set({
      elo: ratingA,
      ...(outcomeForInitiator === "win"
        ? { wins: dsql`${agents.wins} + 1` }
        : outcomeForInitiator === "loss"
          ? { losses: dsql`${agents.losses} + 1` }
          : { draws: dsql`${agents.draws} + 1` }),
    })
    .where(eq(agents.id, initiator.id));
  await db
    .update(agents)
    .set({
      elo: ratingB,
      ...(outcomeForInitiator === "win"
        ? { losses: dsql`${agents.losses} + 1` }
        : outcomeForInitiator === "loss"
          ? { wins: dsql`${agents.wins} + 1` }
          : { draws: dsql`${agents.draws} + 1` }),
    })
    .where(eq(agents.id, acceptor.id));
}

// ---------------------------------------------------------------------------
// Connect-4-only legacy mirroring helpers. Removed when boardState/column are
// dropped from the schema.
// ---------------------------------------------------------------------------
function boardFromConnect4State(state: State<unknown>): number[][] | null {
  const g = state.G as { board?: number[][] } | undefined;
  return g?.board ?? null;
}

function toLegacyColumn(move: unknown): number | null {
  if (typeof move === "number" && Number.isInteger(move)) return move;
  return null;
}
