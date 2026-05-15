/**
 * Connect 4 system bots, adapted to the BotStrategy contract.
 *
 *   easy   → random legal move
 *   medium → negamax depth 3
 *   hard   → negamax depth 5 with center-column + line-window heuristic
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  COLS,
  applyMove,
  checkResult,
  legalMoves,
  opponentOf,
  type Board,
  type Connect4State,
  type Player,
} from "./game";

const WIN_SCORE = 100_000;
const LOSS_SCORE = -100_000;

function chooseMove(board: Board, player: Player, depth: number, useHeuristic: boolean): number {
  const legal = legalMoves(board);
  if (legal.length === 0) throw new Error("chooseMove called on a finished board");

  const order = orderColumnsCenterOut(legal);
  let bestCol = order[0];
  let bestScore = -Infinity;
  for (const col of order) {
    const next = applyMove(board, col, player);
    const score = -negamax(next, opponentOf(player), depth - 1, -Infinity, Infinity, useHeuristic);
    if (score > bestScore) {
      bestScore = score;
      bestCol = col;
    }
  }
  return bestCol;
}

function negamax(
  board: Board,
  toMove: Player,
  depth: number,
  alpha: number,
  beta: number,
  useHeuristic: boolean,
): number {
  const result = checkResult(board);
  if (result.status === "win") {
    return result.winner === toMove ? WIN_SCORE - depth : LOSS_SCORE + depth;
  }
  if (result.status === "draw") return 0;
  if (depth === 0) return useHeuristic ? evaluate(board, toMove) : 0;

  const legal = orderColumnsCenterOut(legalMoves(board));
  let best = -Infinity;
  for (const col of legal) {
    const next = applyMove(board, col, toMove);
    const score = -negamax(next, opponentOf(toMove), depth - 1, -beta, -alpha, useHeuristic);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function evaluate(board: Board, perspective: Player): number {
  let score = 0;
  const opp = opponentOf(perspective);
  const centerCol = Math.floor(COLS / 2);
  for (let r = 0; r < board.length; r++) {
    if (board[r][centerCol] === perspective) score += 3;
    else if (board[r][centerCol] === opp) score -= 3;
  }
  for (const w of enumerateWindows(board)) score += scoreWindow(w, perspective);
  return score;
}

function scoreWindow(cells: number[], me: Player): number {
  const opp = me === 1 ? 2 : 1;
  let mine = 0, theirs = 0;
  for (const c of cells) {
    if (c === me) mine++;
    else if (c === opp) theirs++;
  }
  if (mine > 0 && theirs > 0) return 0;
  if (mine === 4) return 1000;
  if (mine === 3) return 8;
  if (mine === 2) return 2;
  if (theirs === 4) return -1000;
  if (theirs === 3) return -10;
  if (theirs === 2) return -2;
  return 0;
}

function enumerateWindows(board: Board): number[][] {
  const out: number[][] = [];
  const rows = board.length;
  const cols = board[0].length;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c <= cols - 4; c++) {
      out.push([board[r][c], board[r][c + 1], board[r][c + 2], board[r][c + 3]]);
    }
  }
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r <= rows - 4; r++) {
      out.push([board[r][c], board[r + 1][c], board[r + 2][c], board[r + 3][c]]);
    }
  }
  for (let r = 0; r <= rows - 4; r++) {
    for (let c = 0; c <= cols - 4; c++) {
      out.push([board[r][c], board[r + 1][c + 1], board[r + 2][c + 2], board[r + 3][c + 3]]);
    }
  }
  for (let r = 3; r < rows; r++) {
    for (let c = 0; c <= cols - 4; c++) {
      out.push([board[r][c], board[r - 1][c + 1], board[r - 2][c + 2], board[r - 3][c + 3]]);
    }
  }
  return out;
}

function orderColumnsCenterOut(cols: number[]): number[] {
  const center = 3;
  return [...cols].sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
}

function playerFor(playerID: "0" | "1"): Player {
  return playerID === "0" ? 1 : 2;
}

export const easyBot: BotStrategy<Connect4State, number> = {
  pickMove: (state, playerID) => {
    const legal = legalMoves(state.board);
    if (legal.length === 0) throw new Error("easyBot called on a finished board");
    // Note: not seeded — easy is allowed to be non-deterministic in this MVP.
    // If reproducibility matters later, accept an RNG via constructor.
    return legal[Math.floor(Math.random() * legal.length)];
  },
};

export const mediumBot: BotStrategy<Connect4State, number> = {
  pickMove: (state, playerID) => chooseMove(state.board, playerFor(playerID), 3, false),
};

export const hardBot: BotStrategy<Connect4State, number> = {
  pickMove: (state, playerID) => chooseMove(state.board, playerFor(playerID), 5, true),
};
