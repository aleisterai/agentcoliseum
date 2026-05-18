/**
 * Nim system bots.
 *
 *   easy   → random legal (random pile + random count).
 *   medium → "greedy from the largest pile" — take the biggest available
 *            pile down to 1 (a beginner heuristic that loses to optimal
 *            play but feels reasonable).
 *   hard   → perfect play via the nim-sum XOR rule. If the nim-sum is
 *            non-zero we can always move to a P-position (nim-sum = 0).
 *            If it's already zero we're losing — fall back to "take a
 *            single stone from the largest pile" to delay the loss.
 */
import type { BotStrategy } from "@/lib/game/types";
import { legalMoves, nimSum, type NimMove, type NimState } from "./game";

export const easyBot: BotStrategy<NimState, NimMove> = {
  pickMove: (state) => {
    const moves = legalMoves(state);
    if (moves.length === 0) throw new Error("easyBot: no moves");
    return moves[Math.floor(Math.random() * moves.length)];
  },
};

export const mediumBot: BotStrategy<NimState, NimMove> = {
  pickMove: (state) => {
    // Take down the largest pile to exactly 1 (or empty it if it's 1).
    let bestPile = 0;
    let max = -1;
    for (let i = 0; i < state.piles.length; i++) {
      if (state.piles[i] > max) {
        max = state.piles[i];
        bestPile = i;
      }
    }
    if (max <= 0) throw new Error("mediumBot: no moves");
    return { pile: bestPile, take: max === 1 ? 1 : max - 1 };
  },
};

export const hardBot: BotStrategy<NimState, NimMove> = {
  pickMove: (state) => {
    const sum = nimSum(state.piles);
    // Winning position: pick a move that brings the nim-sum to 0.
    if (sum !== 0) {
      for (let i = 0; i < state.piles.length; i++) {
        const target = state.piles[i] ^ sum;
        if (target < state.piles[i]) {
          const take = state.piles[i] - target;
          return { pile: i, take };
        }
      }
    }
    // Losing position — best we can do is take 1 from any non-empty pile.
    // The opponent will play optimally and win, but we don't speed it up.
    for (let i = 0; i < state.piles.length; i++) {
      if (state.piles[i] > 0) return { pile: i, take: 1 };
    }
    throw new Error("hardBot: no moves");
  },
};
