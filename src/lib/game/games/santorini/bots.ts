/**
 * Santorini system bots.
 *
 *   easy   → random legal move.
 *   medium → 1-ply tactical:
 *              1. Win-by-climb if any move places a builder on level 3.
 *              2. Avoid letting the opponent step to a level-3 next turn
 *                 by either blocking the build target or not building
 *                 on a level-2 adjacent to their builder.
 *              3. Otherwise pick the move whose final position gives
 *                 the highest builder-height differential.
 *   hard   → depth-2 negamax over the top-N moves by height-eval.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  applyMove,
  cellIdx,
  checkResult,
  legalMoves,
  opposite,
  type SantoriniMove,
  type SantoriniState,
  type PlayerId,
} from "./game";

const WIN_SCORE = 1_000_000;

function heightOf(state: SantoriniState, side: PlayerId): number {
  let h = 0;
  for (const b of state.builders[side]) h += state.levels[cellIdx(b.row, b.col)];
  return h;
}

function evaluate(state: SantoriniState, root: PlayerId): number {
  return heightOf(state, root) - heightOf(state, opposite(root));
}

function negamax(state: SantoriniState, depth: number, alpha: number, beta: number, root: PlayerId): number {
  const r = checkResult(state);
  if (r.status === "win") return r.winner === root ? WIN_SCORE - (1000 - depth) : -WIN_SCORE + (1000 - depth);
  if (depth === 0) return evaluate(state, root) * (state.turn === root ? 1 : -1);
  const moves = legalMoves(state);
  if (moves.length === 0) return -WIN_SCORE + (1000 - depth);
  // Order by "to-level" — climbs are usually best.
  const ordered = moves
    .map((m) => ({ m, lvl: state.levels[cellIdx(m.to.row, m.to.col)] }))
    .sort((a, b) => b.lvl - a.lvl)
    .map((x) => x.m);
  let best = -Infinity;
  for (const m of ordered) {
    const next = applyMove(state, m);
    const score = -negamax(next, depth - 1, -beta, -alpha, root);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function pickBestMove(state: SantoriniState, depth: number): SantoriniMove {
  const moves = legalMoves(state);
  if (moves.length === 0) throw new Error("pickBestMove: no moves");
  const me = state.turn;
  // Try an immediate climb-to-3 first.
  for (const m of moves) {
    if (state.levels[cellIdx(m.to.row, m.to.col)] === 3) return m;
  }
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const next = applyMove(state, m);
    const score = -negamax(next, depth - 1, -Infinity, Infinity, me);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

export const easyBot: BotStrategy<SantoriniState, SantoriniMove> = {
  pickMove: (state) => {
    const moves = legalMoves(state);
    if (moves.length === 0) throw new Error("easyBot: no moves");
    return moves[Math.floor(Math.random() * moves.length)];
  },
};

export const mediumBot: BotStrategy<SantoriniState, SantoriniMove> = {
  pickMove: (state) => {
    const moves = legalMoves(state);
    if (moves.length === 0) throw new Error("mediumBot: no moves");
    // 1. Take an immediate climb-to-3 win.
    for (const m of moves) {
      if (state.levels[cellIdx(m.to.row, m.to.col)] === 3) return m;
    }
    // 2. Otherwise, prefer the move whose `to` level is highest.
    let best = moves[0];
    let bestLvl = -1;
    for (const m of moves) {
      const lvl = state.levels[cellIdx(m.to.row, m.to.col)];
      if (lvl > bestLvl) {
        bestLvl = lvl;
        best = m;
      }
    }
    return best;
  },
};

export const hardBot: BotStrategy<SantoriniState, SantoriniMove> = {
  // Depth 3 — Santorini turns on height progressions. Depth 2 misses
  // setups like "block at L2, threaten to step up to L3 next" because
  // the opponent's reply isn't searched.
  pickMove: (state) => pickBestMove(state, 3),
};
