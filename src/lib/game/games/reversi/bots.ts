/**
 * Reversi (Othello) system bots.
 *
 *   easy   → random legal move (often plays poorly because greedy capture
 *            is a bad strategy in Reversi).
 *   medium → depth-3 negamax with corner-weighted positional table.
 *   hard   → depth-5 negamax + alpha-beta with corner table + mobility
 *            (legal-move count differential) + parity in the late game.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  SIZE,
  applyMove,
  captureRuns,
  checkResult,
  indexOf,
  legalMoves,
  scoreOf,
  type ReversiMove,
  type ReversiState,
  type Side,
} from "./game";

const WIN_SCORE = 1_000_000;

/**
 * Classic Othello positional table — corners are gold, X-squares (adjacent
 * to corners) are poison. Values are in arbitrary "positional points" and
 * the heuristic combines this with mobility and disc count.
 */
// prettier-ignore
const POSITIONAL_TABLE: number[] = [
  120, -20,  20,   5,   5,  20, -20, 120,
  -20, -40,  -5,  -5,  -5,  -5, -40, -20,
   20,  -5,  15,   3,   3,  15,  -5,  20,
    5,  -5,   3,   3,   3,   3,  -5,   5,
    5,  -5,   3,   3,   3,   3,  -5,   5,
   20,  -5,  15,   3,   3,  15,  -5,  20,
  -20, -40,  -5,  -5,  -5,  -5, -40, -20,
  120, -20,  20,   5,   5,  20, -20, 120,
];

function positionalScore(board: ReadonlyArray<"B" | "W" | "">, side: Side): number {
  let score = 0;
  for (let i = 0; i < board.length; i++) {
    const v = board[i];
    if (v === "") continue;
    score += v === side ? POSITIONAL_TABLE[i] : -POSITIONAL_TABLE[i];
  }
  return score;
}

function mobility(state: ReversiState): number {
  // From state.turn's POV. Approximated as: my legal moves − opponent's
  // legal moves IF they were to move now.
  const mine = legalMoves(state).length;
  const flipped: ReversiState = { ...state, turn: state.turn === "B" ? "W" : "B" };
  const theirs = legalMoves(flipped).length;
  if (mine + theirs === 0) return 0;
  return Math.round(100 * (mine - theirs) / (mine + theirs));
}

function discDiff(state: ReversiState): number {
  // Disc count differential matters more in the endgame than midgame —
  // in the opening, fewer of your own discs is actually better (more
  // mobility). The heuristic caller weights this accordingly.
  const { B, W } = scoreOf(state.board);
  const total = B + W;
  if (total === 0) return 0;
  const mine = state.turn === "B" ? B : W;
  const theirs = state.turn === "B" ? W : B;
  return Math.round(100 * (mine - theirs) / (mine + theirs));
}

function evaluate(state: ReversiState, useHeuristic: boolean): number {
  const { B, W } = scoreOf(state.board);
  const filled = B + W;
  if (!useHeuristic) {
    // medium bot uses positional table only — corners are the main lesson.
    return positionalScore(state.board, state.turn);
  }
  // hard bot blends three signals; weights shift across the game.
  const pos = positionalScore(state.board, state.turn);
  const mob = mobility(state);
  const disc = discDiff(state);
  // Early (<40 filled): mobility + position dominate, disc-count irrelevant.
  // Late (>=50 filled): disc-count dominates.
  if (filled < 30) return pos * 3 + mob * 4;
  if (filled < 50) return pos * 4 + mob * 2 + disc * 1;
  return pos * 2 + mob + disc * 6;
}

function negamax(
  state: ReversiState,
  depth: number,
  alpha: number,
  beta: number,
  useHeuristic: boolean,
): number {
  const result = checkResult(state);
  if (result.status === "win") {
    return result.winner === state.turn ? WIN_SCORE - (1000 - depth) : -WIN_SCORE + (1000 - depth);
  }
  if (result.status === "draw") return 0;
  if (depth === 0) return evaluate(state, useHeuristic);

  const moves = legalMoves(state);
  if (moves.length === 0) {
    // Auto-pass already happened in applyMove; this shouldn't trigger except
    // when the root state has the no-legal-moves condition (unusual). Treat
    // as a flip to the opponent's POV.
    const flipped: ReversiState = { ...state, turn: state.turn === "B" ? "W" : "B" };
    return -negamax(flipped, depth - 1, -beta, -alpha, useHeuristic);
  }

  // Move ordering: try corners first, then high positional value, then center.
  const ordered = moves.slice().sort((a, b) => POSITIONAL_TABLE[indexOf(b.row, b.col)] - POSITIONAL_TABLE[indexOf(a.row, a.col)]);

  let best = -Infinity;
  for (const m of ordered) {
    const next = applyMove(state, m);
    const score = -negamax(next, depth - 1, -beta, -alpha, useHeuristic);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function pickBestMove(state: ReversiState, depth: number, useHeuristic: boolean): ReversiMove {
  const moves = legalMoves(state);
  if (moves.length === 0) throw new Error("pickBestMove called with no legal moves");
  let bestMove = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const next = applyMove(state, m);
    const score = -negamax(next, depth - 1, -Infinity, Infinity, useHeuristic);
    if (score > bestScore) {
      bestScore = score;
      bestMove = m;
    }
  }
  return bestMove;
}

export const easyBot: BotStrategy<ReversiState, ReversiMove> = {
  pickMove: (state) => {
    const legal = legalMoves(state);
    if (legal.length === 0) throw new Error("easyBot called with no legal moves");
    return legal[Math.floor(Math.random() * legal.length)];
  },
};

export const mediumBot: BotStrategy<ReversiState, ReversiMove> = {
  // Reversi is famously bad without positional scoring — corner +
  // edge weights dominate over disc count until the very endgame.
  // Heuristic ON so depth 3 actually sees corner traps.
  pickMove: (state) => pickBestMove(state, 3, true),
};

export const hardBot: BotStrategy<ReversiState, ReversiMove> = {
  pickMove: (state) => pickBestMove(state, 5, true),
};

// Re-export helpers consumers may want to verify against.
export { captureRuns };
