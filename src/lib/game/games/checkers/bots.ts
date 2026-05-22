/**
 * Checkers system bots.
 *
 *   easy   → random legal move; prefers captures when available (the rules
 *            already force them, so this just adds slight bias when slides
 *            are the only option).
 *   medium → negamax depth 4 with material-only eval.
 *   hard   → negamax depth 6 with alpha-beta + material + king bonus +
 *            advancement bonus + back-rank-control nudge.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  SIZE,
  applyMove,
  checkResult,
  legalMoves,
  type CheckersMove,
  type CheckersState,
  type Side,
} from "./game";

const WIN_SCORE = 1_000_000;

const MAN_VALUE = 100;
const KING_VALUE = 175;
const BACK_RANK_BONUS = 5; // discourage abandoning your back rank early
const ADVANCEMENT_BONUS = 2; // per rank toward promotion (men only)

function evaluate(state: CheckersState, perspective: Side, useHeuristic: boolean): number {
  let score = 0;
  for (let i = 0; i < state.board.length; i++) {
    const p = state.board[i];
    if (p === "") continue;
    const side: Side = p[0] as Side;
    const isKing = p[1] === "k";
    let v = isKing ? KING_VALUE : MAN_VALUE;
    if (useHeuristic) {
      const row = Math.floor(i / SIZE);
      if (!isKing) {
        // Men score more the closer they are to promotion.
        const distFromPromotion = side === "W" ? row : 7 - row;
        v += ADVANCEMENT_BONUS * (7 - distFromPromotion);
      }
      // Holding your back rank denies the opponent kings.
      const backRank = side === "W" ? 7 : 0;
      if (row === backRank) v += BACK_RANK_BONUS;
    }
    score += side === perspective ? v : -v;
  }
  return score;
}

function moveKey(m: CheckersMove): string {
  return `${m.from[0]},${m.from[1]}|${m.path.map(([r, c]) => `${r},${c}`).join(">")}`;
}

function orderMoves(moves: CheckersMove[]): CheckersMove[] {
  // Longer capture chains first — better pruning for hard bot.
  return moves.slice().sort((a, b) => b.path.length - a.path.length);
}

function negamax(
  state: CheckersState,
  depth: number,
  alpha: number,
  beta: number,
  useHeuristic: boolean,
): number {
  const result = checkResult(state);
  if (result.status === "win") return -WIN_SCORE + (1000 - depth);
  if (result.status === "draw") return 0;
  if (depth === 0) return evaluate(state, state.turn, useHeuristic);

  const moves = orderMoves(legalMoves(state));
  let best = -Infinity;
  for (const m of moves) {
    const next = applyMove(state, m);
    const score = -negamax(next, depth - 1, -beta, -alpha, useHeuristic);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function pickBestMove(state: CheckersState, depth: number, useHeuristic: boolean): CheckersMove {
  const moves = orderMoves(legalMoves(state));
  if (moves.length === 0) throw new Error("pickBestMove called on a finished board");
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

export const easyBot: BotStrategy<CheckersState, CheckersMove> = {
  pickMove: (state) => {
    const legal = legalMoves(state);
    if (legal.length === 0) throw new Error("easyBot called on a finished board");
    return legal[Math.floor(Math.random() * legal.length)];
  },
};

export const mediumBot: BotStrategy<CheckersState, CheckersMove> = {
  // Heuristic ON so non-terminal leaves are scored by material +
  // king count + advancement. Without it, the bot at depth 4
  // returned 0 for any line not ending in a forced win/loss within
  // 4 plies — which means it couldn't tell "trade my piece for
  // nothing" from "develop a king."
  pickMove: (state) => pickBestMove(state, 4, true),
};

export const hardBot: BotStrategy<CheckersState, CheckersMove> = {
  pickMove: (state) => pickBestMove(state, 6, true),
};

export { moveKey };
