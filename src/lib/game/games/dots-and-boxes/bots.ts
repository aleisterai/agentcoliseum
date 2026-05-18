/**
 * Dots & Boxes system bots.
 *
 * Key D&B insight: in the endgame, control of chains matters more than
 * raw box count. The "long-chain rule" — give the opponent the SHORTEST
 * chain available — is the central idea.
 *
 *   easy   → random legal move
 *   medium → 1-ply tactical:
 *              1. complete a box if any move does (most boxes wins ties)
 *              2. otherwise avoid creating a 3-sided box for the opponent
 *              3. else random "safe" move
 *   hard   → depth-3 negamax over moves with simple eval (score diff +
 *            "3-sided boxes given away" penalty). Strong enough to never
 *            give a free chain when one can be avoided.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  applyMove,
  BOX_COLS,
  BOX_ROWS,
  checkResult,
  legalMoves,
  opposite,
  sidesOfBox,
  type DotsBoxesMove,
  type DotsBoxesState,
} from "./game";

const WIN_SCORE = 1_000_000;

function countThreeSidedBoxes(state: DotsBoxesState): number {
  let n = 0;
  for (let r = 0; r < BOX_ROWS; r++) {
    for (let c = 0; c < BOX_COLS; c++) {
      if (state.boxes[r * BOX_COLS + c] !== "") continue;
      if (sidesOfBox(state, r, c) === 3) n++;
    }
  }
  return n;
}

/** From the side-to-move's POV. Positive favors them. */
function evaluate(state: DotsBoxesState, perspective: "0" | "1"): number {
  const opp = opposite(perspective);
  const scoreDiff = state.scores[perspective] - state.scores[opp];
  // Penalty: each 3-sided box on the board is potentially a free point
  // for whoever moves next. If it's our turn, they're potentially OURS
  // — small bonus. If it's the opponent's turn, hurt us.
  const threeBoxes = countThreeSidedBoxes(state);
  const sign = state.turn === perspective ? +1 : -1;
  return scoreDiff * 10 + sign * threeBoxes * 2;
}

/**
 * Returns the count of NEW boxes completed if `side` plays `move` from
 * `state`. Used by medium bot to grab any free boxes immediately.
 */
function boxesCompletedBy(state: DotsBoxesState, move: DotsBoxesMove): number {
  const before = state.scores[state.turn];
  const next = applyMove(state, move);
  return next.scores[state.turn] - before;
}

/**
 * Would this move create a new 3-sided box for the opponent (i.e. set
 * up an immediate free point on their next turn)?
 */
function createsThreeSided(state: DotsBoxesState, move: DotsBoxesMove): boolean {
  const before = countThreeSidedBoxes(state);
  const next = applyMove(state, move);
  // If our move COMPLETED a box, the turn doesn't flip — so the 3-sided
  // count isn't relevant to "giving" anything to the opponent.
  if (next.turn === state.turn) return false;
  return countThreeSidedBoxes(next) > before;
}

function negamax(state: DotsBoxesState, depth: number, alpha: number, beta: number, root: "0" | "1"): number {
  const r = checkResult(state);
  if (r.status === "win") return r.winner === root ? WIN_SCORE - (1000 - depth) : -WIN_SCORE + (1000 - depth);
  if (r.status === "draw") return 0;
  if (depth === 0) return evaluate(state, root) * (state.turn === root ? 1 : -1);

  // Move ordering: try edges that complete boxes first (free points are
  // always best); then edges that DON'T give a 3-sided box; then the rest.
  const moves = legalMoves(state)
    .map((m) => ({ m, completes: boxesCompletedBy(state, m), gives: createsThreeSided(state, m) }))
    .sort((a, b) => {
      if (b.completes !== a.completes) return b.completes - a.completes;
      return Number(a.gives) - Number(b.gives);
    })
    .map((x) => x.m);

  let best = -Infinity;
  for (const m of moves) {
    const next = applyMove(state, m);
    // If the same player goes again (box completed), score stays in their
    // POV — don't negate. Otherwise negate as standard negamax.
    const score = next.turn === state.turn
      ? negamax(next, depth - 1, alpha, beta, root)
      : -negamax(next, depth - 1, -beta, -alpha, root);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function pickBestMove(state: DotsBoxesState, depth: number): DotsBoxesMove {
  const moves = legalMoves(state);
  if (moves.length === 0) throw new Error("pickBestMove called with no legal moves");
  const me = state.turn;
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const next = applyMove(state, m);
    const score = next.turn === me
      ? negamax(next, depth - 1, -Infinity, Infinity, me)
      : -negamax(next, depth - 1, -Infinity, Infinity, me);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

export const easyBot: BotStrategy<DotsBoxesState, DotsBoxesMove> = {
  pickMove: (state) => {
    const legal = legalMoves(state);
    if (legal.length === 0) throw new Error("easyBot: no moves");
    return legal[Math.floor(Math.random() * legal.length)];
  },
};

export const mediumBot: BotStrategy<DotsBoxesState, DotsBoxesMove> = {
  pickMove: (state) => {
    const legal = legalMoves(state);
    if (legal.length === 0) throw new Error("mediumBot: no moves");
    // 1. Take any free box.
    const completes = legal
      .map((m) => ({ m, n: boxesCompletedBy(state, m) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n);
    if (completes.length > 0) return completes[0].m;
    // 2. Avoid giving a 3-sided box.
    const safe = legal.filter((m) => !createsThreeSided(state, m));
    if (safe.length > 0) return safe[Math.floor(Math.random() * safe.length)];
    // 3. All moves are bad — pick one that gives the smallest chain (heuristic:
    //    minimize the number of new 3-sided boxes created, then random).
    let best = legal[0];
    let bestGiven = Number.POSITIVE_INFINITY;
    for (const m of legal) {
      const next = applyMove(state, m);
      const given = countThreeSidedBoxes(next);
      if (given < bestGiven) {
        bestGiven = given;
        best = m;
      }
    }
    return best;
  },
};

export const hardBot: BotStrategy<DotsBoxesState, DotsBoxesMove> = {
  pickMove: (state) => pickBestMove(state, 3),
};
