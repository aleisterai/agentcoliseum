/**
 * Liar's Dice system bots.
 *
 * IMPORTANT: a bot may only read ITS OWN cup (`state.dice[playerID]`). The
 * state object carries both cups (the engine is the source of truth), but
 * peeking at the opponent's dice would be cheating — every bot below reads
 * only its own hand + the public dice counts.
 *
 *   easy   → random legal action.
 *   medium → expected-value heuristic: challenge when the standing bid
 *            exceeds what's plausible, else make a minimal legal raise.
 *   hard   → binomial tail estimate of the opponent's unknown dice:
 *            challenge when P(bid is true) < 0.5, else raise to the most
 *            defensible bid grounded in its own hand.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  FACES,
  bidIsHigher,
  legalMoves,
  opposite,
  totalDiceOnTable,
  type Bid,
  type LiarsDiceMove,
  type LiarsDiceState,
  type PlayerId,
} from "./game";

function handCount(dice: number[], face: number): number {
  let n = 0;
  for (const d of dice) if (d === face) n++;
  return n;
}

/** Most frequent face in a hand; ties → higher face. Returns {face, count}. */
function bestFace(dice: number[]): { face: number; count: number } {
  let bestF = 1;
  let bestC = -1;
  for (let f = 1; f <= FACES; f++) {
    const c = handCount(dice, f);
    if (c >= bestC) {
      bestC = c;
      bestF = f;
    }
  }
  return { face: bestF, count: bestC };
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/** P(X >= k) for X ~ Binomial(n, p). n is small (≤5) so compute exactly. */
function binomTailGE(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let total = 0;
  for (let i = k; i <= n; i++) {
    total += choose(n, i) * Math.pow(p, i) * Math.pow(1 - p, n - i);
  }
  return total;
}

/** First legal raise above the standing bid, preferring a face the bot holds. */
function minimalRaise(s: LiarsDiceState, myDice: number[]): Bid | null {
  const prev = s.bid!;
  // Try same quantity, higher face (prefer a face we actually hold).
  for (let f = prev.face + 1; f <= FACES; f++) {
    const cand = { quantity: prev.quantity, face: f };
    if (bidIsHigher(prev, cand) && cand.quantity <= totalDiceOnTable(s)) {
      return cand;
    }
  }
  // Bump quantity; pick the face we hold most of.
  const q = prev.quantity + 1;
  if (q <= totalDiceOnTable(s)) {
    const bf = bestFace(myDice);
    return { quantity: q, face: bf.face };
  }
  return null; // nothing higher is legal → caller must challenge
}

function openingBid(s: LiarsDiceState, myDice: number[], oppN: number, lean: number): Bid {
  const bf = bestFace(myDice);
  const expectedOpp = Math.round((oppN / FACES) * lean);
  const quantity = Math.min(
    totalDiceOnTable(s),
    Math.max(1, bf.count + expectedOpp),
  );
  return { quantity, face: bf.face };
}

export const easyBot: BotStrategy<LiarsDiceState, LiarsDiceMove> = {
  pickMove: (state) => {
    const moves = legalMoves(state);
    if (moves.length === 0) throw new Error("easyBot: no moves");
    return moves[Math.floor(Math.random() * moves.length)];
  },
};

export const mediumBot: BotStrategy<LiarsDiceState, LiarsDiceMove> = {
  pickMove: (state, playerID) => {
    const me: PlayerId = playerID;
    const myDice = state.dice[me];
    const oppN = state.diceCount[opposite(me)];

    if (state.bid === null) {
      return { kind: "bid", ...openingBid(state, myDice, oppN, 0) };
    }
    const { quantity, face } = state.bid;
    const myC = handCount(myDice, face);
    const maxPossible = myC + oppN;
    // Definitely impossible → challenge.
    if (quantity > maxPossible) return { kind: "challenge" };
    // Implausible (above my count + opponent's expected, with a margin).
    const expectedTotal = myC + oppN / FACES;
    if (quantity > expectedTotal + 1) return { kind: "challenge" };
    const raise = minimalRaise(state, myDice);
    return raise ? { kind: "bid", ...raise } : { kind: "challenge" };
  },
};

export const hardBot: BotStrategy<LiarsDiceState, LiarsDiceMove> = {
  pickMove: (state, playerID) => {
    const me: PlayerId = playerID;
    const myDice = state.dice[me];
    const oppN = state.diceCount[opposite(me)];

    if (state.bid === null) {
      return { kind: "bid", ...openingBid(state, myDice, oppN, 1) };
    }
    const { quantity, face } = state.bid;
    const myC = handCount(myDice, face);
    const need = quantity - myC; // how many the opponent must be holding
    if (need > oppN) return { kind: "challenge" }; // impossible
    const pTrue = binomTailGE(oppN, need, 1 / FACES);
    if (pTrue < 0.5) return { kind: "challenge" };
    // Bid stands a decent chance — raise on our own strongest face when we
    // can, else the minimal legal raise.
    const bf = bestFace(myDice);
    const groundedRaise: Bid = {
      quantity: Math.min(
        totalDiceOnTable(state),
        Math.max(quantity, bf.count + Math.round(oppN / FACES)),
      ),
      face: bf.face,
    };
    if (bidIsHigher(state.bid, groundedRaise)) {
      return { kind: "bid", ...groundedRaise };
    }
    const raise = minimalRaise(state, myDice);
    return raise ? { kind: "bid", ...raise } : { kind: "challenge" };
  },
};
