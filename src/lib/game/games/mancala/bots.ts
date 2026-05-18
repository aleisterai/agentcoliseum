/**
 * Mancala system bots.
 *
 *   easy   → random legal pit
 *   medium → 1-ply tactical: take a move that captures OR keeps the turn
 *            (bonus-turn rule). Otherwise pick the move that maximizes
 *            seeds added to OUR store.
 *   hard   → depth-6 negamax with alpha-beta. Branching factor is at
 *            most 6, so depth 6 is fast (max ~46k nodes).
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  STORE_0,
  STORE_1,
  applyMove,
  checkResult,
  legalMoves,
  opposite,
  type MancalaMove,
  type MancalaState,
  type PlayerId,
} from "./game";

const WIN_SCORE = 1_000_000;

function evaluate(state: MancalaState, root: PlayerId): number {
  const sMe = state.pits[root === "0" ? STORE_0 : STORE_1];
  const sOpp = state.pits[root === "0" ? STORE_1 : STORE_0];
  return sMe - sOpp;
}

function negamax(state: MancalaState, depth: number, alpha: number, beta: number, root: PlayerId): number {
  const r = checkResult(state);
  if (r.status === "win") return r.winner === root ? WIN_SCORE - (1000 - depth) : -WIN_SCORE + (1000 - depth);
  if (r.status === "draw") return 0;
  if (depth === 0) return evaluate(state, root);

  const moves = legalMoves(state);
  // Move ordering: bonus-turn moves (end in own store) first, then high-yield.
  const ordered = moves.slice().sort((a, b) => {
    const seedsA = state.pits[a.pit];
    const seedsB = state.pits[b.pit];
    return seedsB - seedsA;
  });

  let best = -Infinity;
  for (const m of ordered) {
    const next = applyMove(state, m);
    const sameTurn = next.turn === state.turn; // bonus-turn case
    const score = sameTurn
      ? negamax(next, depth - 1, alpha, beta, root)
      : -negamax(next, depth - 1, -beta, -alpha, root);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function pickBestMove(state: MancalaState, depth: number): MancalaMove {
  const moves = legalMoves(state);
  if (moves.length === 0) throw new Error("pickBestMove: no moves");
  const me = state.turn;
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const next = applyMove(state, m);
    const sameTurn = next.turn === state.turn;
    const score = sameTurn
      ? negamax(next, depth - 1, -Infinity, Infinity, me)
      : -negamax(next, depth - 1, -Infinity, Infinity, me);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

export const easyBot: BotStrategy<MancalaState, MancalaMove> = {
  pickMove: (state) => {
    const legal = legalMoves(state);
    if (legal.length === 0) throw new Error("easyBot: no moves");
    return legal[Math.floor(Math.random() * legal.length)];
  },
};

export const mediumBot: BotStrategy<MancalaState, MancalaMove> = {
  pickMove: (state) => {
    // Rank legal moves by (store gain this turn) + small bonus for
    // keeping the turn. A 4-seed capture beats a 1-seed bonus-turn move;
    // a tied store gain breaks toward the bonus-turn option.
    const legal = legalMoves(state);
    if (legal.length === 0) throw new Error("mediumBot: no moves");
    const me = state.turn;
    const myStore = me === "0" ? STORE_0 : STORE_1;

    let best = legal[0];
    let bestScore = -Infinity;
    for (const m of legal) {
      const next = applyMove(state, m);
      const storeGain = next.pits[myStore] - state.pits[myStore];
      const bonusTurn = next.turn === me ? 2 : 0;
      const score = storeGain + bonusTurn;
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  },
};

export const hardBot: BotStrategy<MancalaState, MancalaMove> = {
  pickMove: (state) => pickBestMove(state, 6),
};
