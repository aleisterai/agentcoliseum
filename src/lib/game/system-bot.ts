/**
 * Three difficulty levels of "vs system bot" opponent.
 *
 *   easy   → random legal move
 *   medium → negamax, depth 3
 *   hard   → negamax, depth 5, with a center-column heuristic
 *
 * System-bot games do NOT affect Elo (spec). They're a sandbox for practice
 * and a low-stakes ramp for new agents to verify their integration.
 */
import {
  applyMove,
  checkResult,
  COLS,
  isLegalMove,
  legalMoves,
  opponentOf,
  type Board,
  type Player,
} from "./connect4";

export type Difficulty = "easy" | "medium" | "hard";

/** Pick a move for `player` to play on `board`. Returns the chosen column. */
export function chooseMove(board: Board, player: Player, difficulty: Difficulty): number {
  const legal = legalMoves(board);
  if (legal.length === 0) {
    throw new Error("chooseMove called on a finished board");
  }

  if (difficulty === "easy") {
    return legal[Math.floor(Math.random() * legal.length)];
  }

  const depth = difficulty === "medium" ? 3 : 5;
  const useHeuristic = difficulty === "hard";

  // Search column order: center-out, since center participates in more lines.
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

const WIN_SCORE = 100_000;
const LOSS_SCORE = -100_000;

/** Pure negamax with alpha-beta pruning. Returns score from `toMove`'s POV. */
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
    // toMove is about to move on a board that's already won — that means
    // the previous player won. Score is negative for the side about to move.
    return result.winner === toMove ? WIN_SCORE - depth : LOSS_SCORE + depth;
  }
  if (result.status === "draw") return 0;
  if (depth === 0) {
    return useHeuristic ? evaluate(board, toMove) : 0;
  }

  const legal = orderColumnsCenterOut(legalMoves(board));
  let best = -Infinity;
  for (const col of legal) {
    const next = applyMove(board, col, toMove);
    const score = -negamax(next, opponentOf(toMove), depth - 1, -beta, -alpha, useHeuristic);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // prune
  }
  return best;
}

/**
 * Heuristic eval for non-terminal nodes. Counts open 2/3-in-a-rows weighted
 * heavily, with a flat center-column bonus. Cheap and bias-free enough to
 * make a depth-5 search noticeably stronger than random.
 */
function evaluate(board: Board, perspective: Player): number {
  let score = 0;
  const opp = opponentOf(perspective);

  // Center column bonus
  const centerCol = Math.floor(COLS / 2);
  for (let r = 0; r < board.length; r++) {
    if (board[r][centerCol] === perspective) score += 3;
    else if (board[r][centerCol] === opp) score -= 3;
  }

  // Score all length-4 windows
  const windows = enumerateWindows(board);
  for (const w of windows) {
    score += scoreWindow(w, perspective);
  }
  return score;
}

function scoreWindow(cells: number[], me: Player): number {
  const opp = me === 1 ? 2 : 1;
  let mine = 0;
  let theirs = 0;
  for (const c of cells) {
    if (c === me) mine++;
    else if (c === opp) theirs++;
  }
  if (mine > 0 && theirs > 0) return 0; // contested → neutral
  if (mine === 4) return 1000;
  if (mine === 3) return 8;
  if (mine === 2) return 2;
  if (theirs === 4) return -1000;
  if (theirs === 3) return -10; // value blocking slightly more than building
  if (theirs === 2) return -2;
  return 0;
}

function enumerateWindows(board: Board): number[][] {
  const out: number[][] = [];
  const rows = board.length;
  const cols = board[0].length;
  // Horizontal
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c <= cols - 4; c++) {
      out.push([board[r][c], board[r][c + 1], board[r][c + 2], board[r][c + 3]]);
    }
  }
  // Vertical
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r <= rows - 4; r++) {
      out.push([board[r][c], board[r + 1][c], board[r + 2][c], board[r + 3][c]]);
    }
  }
  // ↘
  for (let r = 0; r <= rows - 4; r++) {
    for (let c = 0; c <= cols - 4; c++) {
      out.push([board[r][c], board[r + 1][c + 1], board[r + 2][c + 2], board[r + 3][c + 3]]);
    }
  }
  // ↗
  for (let r = 3; r < rows; r++) {
    for (let c = 0; c <= cols - 4; c++) {
      out.push([board[r][c], board[r - 1][c + 1], board[r - 2][c + 2], board[r - 3][c + 3]]);
    }
  }
  return out;
}

/** [3, 4, 2, 5, 1, 6, 0] for a 7-column board. */
function orderColumnsCenterOut(cols: number[]): number[] {
  const center = 3;
  return [...cols].sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
}

// Re-export so callers don't need to import from connect4 just to check legality.
export { isLegalMove };
