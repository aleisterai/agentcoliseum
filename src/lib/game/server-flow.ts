/**
 * Server-side game flow primitives. Shared between the move endpoint, the
 * timeout cron, and any future admin tools.
 *
 *   applyMoveTransaction()  — applies a move, advances turn, records the move row
 *   finalizeGame()          — marks a game completed, updates Elo, schedules treasury
 *   driveSystemBotIfNeeded()— if it's the system-bot's turn, plays its move
 *
 * Pure-game helpers stay in lib/game/connect4.ts. This file holds the DB-bound
 * orchestration.
 */
import "server-only";
import { eq, sql as dsql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, games, moves, treasuryFlows, type Game } from "@/lib/db/schema";
import {
  applyMove as applyToBoard,
  checkResult,
  isLegalMove,
  type Player,
} from "@/lib/game/connect4";
import { chooseMove } from "@/lib/game/system-bot";
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

/**
 * Apply a single move from `agentId` in `gameId` at `column`. Validates turn
 * order, legality, applies it, runs result detection, and triggers cascading
 * effects (Elo update + treasury on win, system-bot reply on system games).
 *
 * Returns the updated game row.
 */
export async function applyMoveTransaction(input: {
  gameId: string;
  agentId: string;
  column: number;
  thinkingMs: number;
  x402PaymentId?: string;
}): Promise<Game> {
  const start = Date.now();
  const game = await db.query.games.findFirst({ where: eq(games.id, input.gameId) });
  if (!game) throw new IllegalMoveError("game_not_found");
  if (game.status !== "active") throw new IllegalMoveError("not_active");
  if (game.currentTurnAgentId !== input.agentId) throw new NotYourTurnError();
  if (!isLegalMove(game.boardState as number[][], input.column)) {
    throw new IllegalMoveError("illegal_move");
  }

  // Determine which player number this agent is (1 = initiator, 2 = acceptor).
  const playerNumber: Player = game.initiatorAgentId === input.agentId ? 1 : 2;

  const nextBoard = applyToBoard(game.boardState as number[][], input.column, playerNumber);
  const result = checkResult(nextBoard);
  const moveNumber = await nextMoveNumber(game.id);

  // Insert move row.
  await db.insert(moves).values({
    gameId: game.id,
    agentId: input.agentId,
    moveNumber,
    column: input.column,
    boardStateAfter: nextBoard,
    thinkingMs: input.thinkingMs,
    x402PaymentId: input.x402PaymentId,
  });

  let updatedGame: Game;
  if (result.status === "ongoing") {
    // Flip turn. For system games, opponent may be system-bot (NULL).
    const nextTurn = nextTurnAgentId(game, input.agentId);
    const [u] = await db
      .update(games)
      .set({
        boardState: nextBoard,
        currentTurnAgentId: nextTurn,
        lastMoveAt: new Date(),
      })
      .where(eq(games.id, game.id))
      .returning();
    updatedGame = u;

    await broadcastGame(game.id, realtimeEvent.MovePlayed, {
      gameId: game.id,
      moveNumber,
      column: input.column,
      boardStateAfter: nextBoard,
      currentTurnAgentId: nextTurn,
      tookMs: Date.now() - start,
    });

    // If it's now the system-bot's turn, auto-play.
    if (game.mode === "system" && nextTurn === null) {
      updatedGame = await driveSystemBot(updatedGame);
    }
    return updatedGame;
  }

  // Game over — win or draw.
  const winnerAgentId = result.status === "win" ? input.agentId : null;
  updatedGame = await finalizeGame(game, nextBoard, winnerAgentId);
  await broadcastGame(game.id, realtimeEvent.MovePlayed, {
    gameId: game.id,
    moveNumber,
    column: input.column,
    boardStateAfter: nextBoard,
    currentTurnAgentId: null,
    tookMs: Date.now() - start,
  });
  await broadcastGame(game.id, realtimeEvent.GameEnded, {
    gameId: game.id,
    winnerAgentId,
    status: "completed",
    line: result.status === "win" ? result.line : null,
  });
  await broadcastLobby(realtimeEvent.GameEnded, { id: game.id });
  return updatedGame;
}

/** Apply a system-bot move on its turn. Loops if multiple bot moves are needed. */
export async function driveSystemBot(game: Game): Promise<Game> {
  // Bot is always player 2 in our convention (initiator is the human → player 1).
  const board = game.boardState as number[][];
  const difficulty = (game.systemBotDifficulty as "easy" | "medium" | "hard") ?? "easy";
  const start = Date.now();
  const col = chooseMove(board, 2, difficulty);
  const nextBoard = applyToBoard(board, col, 2);
  const result = checkResult(nextBoard);
  const moveNumber = await nextMoveNumber(game.id);

  await db.insert(moves).values({
    gameId: game.id,
    agentId: null, // null = system bot
    moveNumber,
    column: col,
    boardStateAfter: nextBoard,
    thinkingMs: Date.now() - start,
  });

  if (result.status === "ongoing") {
    const [u] = await db
      .update(games)
      .set({
        boardState: nextBoard,
        currentTurnAgentId: game.initiatorAgentId,
        lastMoveAt: new Date(),
      })
      .where(eq(games.id, game.id))
      .returning();
    await broadcastGame(game.id, realtimeEvent.MovePlayed, {
      gameId: game.id,
      moveNumber,
      column: col,
      boardStateAfter: nextBoard,
      currentTurnAgentId: u.currentTurnAgentId,
      isBot: true,
    });
    return u;
  }

  // Bot wins or draws. Winner is null on draw; for a bot win, winner is null
  // (we can't reference a non-existent agent), but the human loses.
  const winnerAgentId = result.status === "win" ? null : null;
  return finalizeGame(game, nextBoard, winnerAgentId, /* botWonSystem */ result.status === "win");
}

async function nextMoveNumber(gameId: string): Promise<number> {
  const row = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(moves)
    .where(eq(moves.gameId, gameId));
  return row[0]?.n ?? 0;
}

function nextTurnAgentId(game: Game, justMovedAgentId: string): string | null {
  if (game.mode === "system") {
    // Initiator just moved → bot's turn (null). Bot just moved → initiator.
    return justMovedAgentId === game.initiatorAgentId ? null : game.initiatorAgentId;
  }
  return justMovedAgentId === game.initiatorAgentId
    ? game.acceptorAgentId
    : game.initiatorAgentId;
}

/**
 * Mark the game completed, update Elo (only for non-system games), and queue
 * a treasury flow for the platform fee.
 *
 * For system games we do NOT touch Elo; for paid games we mint a treasury
 * flow row for the 5% fee.
 */
export async function finalizeGame(
  game: Game,
  finalBoard: number[][],
  winnerAgentId: string | null,
  systemBotWon = false,
): Promise<Game> {
  const now = new Date();

  // Update game row.
  const [updated] = await db
    .update(games)
    .set({
      boardState: finalBoard,
      status: "completed",
      winnerAgentId,
      currentTurnAgentId: null,
      lastMoveAt: now,
      completedAt: now,
    })
    .where(eq(games.id, game.id))
    .returning();

  // Elo + W/L/D — only for free or paid games (system games don't affect Elo).
  if (game.mode !== "system" && game.initiatorAgentId && game.acceptorAgentId) {
    await applyEloOutcome({
      initiatorId: game.initiatorAgentId,
      acceptorId: game.acceptorAgentId,
      winnerId: winnerAgentId,
    });
  } else if (game.mode === "system" && game.initiatorAgentId) {
    // System game: increment the human's W/L (no Elo change).
    const col = systemBotWon ? agents.losses : winnerAgentId === game.initiatorAgentId ? agents.wins : agents.draws;
    await db
      .update(agents)
      .set({ [(col as unknown as { name: string }).name]: dsql`${col} + 1` })
      .where(eq(agents.id, game.initiatorAgentId));
  }

  // Treasury fee for paid games.
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

  const { ratingA, ratingB } = updateRatings(
    initiator.elo,
    acceptor.elo,
    outcomeForInitiator,
  );

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
