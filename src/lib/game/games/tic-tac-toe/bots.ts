/**
 * Tic-Tac-Toe system bots.
 *
 *   easy   → random legal move
 *   medium → 1-ply tactical: win-if-can, block-if-must, else random
 *   hard   → perfect-play minimax over the whole tree (3⁹ ≈ 20k states max)
 *
 * Tic-Tac-Toe is solved — `hard` will always draw or win, never lose.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  CELLS,
  applyMove,
  checkResult,
  legalMoves,
  opponentOf,
  type Board,
  type Player,
  type TicTacToeState,
} from "./game";

const WIN_SCORE = 1000;
const LOSS_SCORE = -1000;

function playerFor(playerID: "0" | "1"): Player {
  return playerID === "0" ? 1 : 2;
}

/** Pick the first move that immediately wins for `player`, else null. */
function immediateWin(board: Board, player: Player): number | null {
  for (const cell of legalMoves(board)) {
    const next = applyMove(board, cell, player);
    const r = checkResult(next);
    if (r.status === "win" && r.winner === player) return cell;
  }
  return null;
}

/**
 * Negamax with full tree search. Tic-Tac-Toe has at most ~250k leaf nodes
 * from the root, well within depth-9 brute force, so no alpha-beta needed
 * for correctness — but we still prune to keep tests snappy.
 */
function negamax(board: Board, toMove: Player, alpha: number, beta: number): number {
  const result = checkResult(board);
  if (result.status === "win") {
    return result.winner === toMove ? WIN_SCORE : LOSS_SCORE;
  }
  if (result.status === "draw") return 0;

  let best = -Infinity;
  for (const cell of legalMoves(board)) {
    const next = applyMove(board, cell, toMove);
    const score = -negamax(next, opponentOf(toMove), -beta, -alpha);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function bestMove(board: Board, player: Player): number {
  const legal = legalMoves(board);
  if (legal.length === 0) throw new Error("bestMove called on a finished board");
  let chosen = legal[0];
  let bestScore = -Infinity;
  for (const cell of legal) {
    const next = applyMove(board, cell, player);
    const score = -negamax(next, opponentOf(player), -Infinity, Infinity);
    if (score > bestScore) {
      bestScore = score;
      chosen = cell;
    }
  }
  return chosen;
}

export const easyBot: BotStrategy<TicTacToeState, number> = {
  pickMove: (state) => {
    const legal = legalMoves(state.board);
    if (legal.length === 0) throw new Error("easyBot called on a finished board");
    return legal[Math.floor(Math.random() * legal.length)];
  },
};

export const mediumBot: BotStrategy<TicTacToeState, number> = {
  pickMove: (state, playerID) => {
    const me = playerFor(playerID);
    const opp = opponentOf(me);
    const win = immediateWin(state.board, me);
    if (win !== null) return win;
    const block = immediateWin(state.board, opp);
    if (block !== null) return block;
    // Prefer center, then corners, then edges — gives medium a slight edge.
    const order = [4, 0, 2, 6, 8, 1, 3, 5, 7];
    for (const cell of order) {
      if (cell >= 0 && cell < CELLS && state.board[cell] === 0) return cell;
    }
    // Fallback (should be unreachable on an ongoing board).
    return legalMoves(state.board)[0];
  },
};

export const hardBot: BotStrategy<TicTacToeState, number> = {
  pickMove: (state, playerID) => bestMove(state.board, playerFor(playerID)),
};
