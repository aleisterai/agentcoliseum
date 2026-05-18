/**
 * Nine Men's Morris system bots.
 *
 *   easy   → random legal move.
 *   medium → 1-ply tactical:
 *              1. take any move that forms a mill (capture an opponent
 *                 piece — high-value).
 *              2. otherwise block a 2-in-a-row threat from the opponent
 *                 (would-be-mill) when one exists.
 *              3. else random.
 *   hard   → depth-3 negamax over the enumerated legal-move list (with
 *            removal choice baked in). Eval = piece differential + mill
 *            count differential. The branching factor in early placement
 *            is large (~24); later phases drop fast.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  MILLS,
  NUM_POINTS,
  applyMove,
  checkResult,
  isInMill,
  legalMoves,
  opposite,
  type NMMMove,
  type NMMState,
  type PlayerId,
} from "./game";

const WIN_SCORE = 1_000_000;

function countMills(points: ReadonlyArray<"" | "0" | "1">, side: PlayerId): number {
  let n = 0;
  for (const [a, b, c] of MILLS) {
    if (points[a] === side && points[b] === side && points[c] === side) n++;
  }
  return n;
}

function evaluate(state: NMMState, root: PlayerId): number {
  const opp = opposite(root);
  const pieceDiff = state.alive[root] - state.alive[opp];
  const millDiff = countMills(state.points, root) - countMills(state.points, opp);
  return pieceDiff * 100 + millDiff * 30;
}

/** Would the opponent form a mill on THEIR next move if we don't block? */
function opponentMillThreats(state: NMMState): Array<{ from: number | null; to: number }> {
  // Hypothetical "opponent moves next" — enumerate THEIR plays that form
  // a mill. The caller then plays a move that prevents these threats.
  const flipped: NMMState = { ...state, turn: opposite(state.turn) };
  const threats: Array<{ from: number | null; to: number }> = [];
  for (const m of legalMoves(flipped)) {
    // legalMoves returns enumerated removal targets too — collapse to play.
    if (m.remove === undefined) continue;
    threats.push({ from: m.from, to: m.to });
  }
  return threats;
}

function negamax(state: NMMState, depth: number, alpha: number, beta: number, root: PlayerId): number {
  const r = checkResult(state);
  if (r.status === "win") return r.winner === root ? WIN_SCORE - (1000 - depth) : -WIN_SCORE + (1000 - depth);
  if (depth === 0) return evaluate(state, root) * (state.turn === root ? 1 : -1);

  const moves = legalMoves(state);
  if (moves.length === 0) return -WIN_SCORE + (1000 - depth); // current side has no move → loses
  // Move ordering: mill-forming moves first.
  const ordered = moves.slice().sort((a, b) => {
    const aMill = a.remove !== undefined ? 1 : 0;
    const bMill = b.remove !== undefined ? 1 : 0;
    return bMill - aMill;
  });
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

function pickBestMove(state: NMMState, depth: number): NMMMove {
  const moves = legalMoves(state);
  if (moves.length === 0) throw new Error("pickBestMove: no moves");
  const me = state.turn;
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

export const easyBot: BotStrategy<NMMState, NMMMove> = {
  pickMove: (state) => {
    const moves = legalMoves(state);
    if (moves.length === 0) throw new Error("easyBot: no moves");
    return moves[Math.floor(Math.random() * moves.length)];
  },
};

export const mediumBot: BotStrategy<NMMState, NMMMove> = {
  pickMove: (state) => {
    const moves = legalMoves(state);
    if (moves.length === 0) throw new Error("mediumBot: no moves");
    // 1. Take a mill if available — high gain. Prefer removing an opponent
    //    piece that's NOT in a mill if possible (already enforced in
    //    legalMoves: each mill-forming move has one variant per legal
    //    removal target).
    const millMoves = moves.filter((m) => m.remove !== undefined);
    if (millMoves.length > 0) return millMoves[Math.floor(Math.random() * millMoves.length)];
    // 2. Block an opponent mill threat (an empty point that completes
    //    one of their mills if they place/move there next turn).
    const threats = opponentMillThreats(state);
    if (threats.length > 0) {
      // Pick any move where our `to` matches a threat target — that
      // blocks one of their potential mills.
      const blockMoves = moves.filter((m) => threats.some((t) => t.to === m.to));
      if (blockMoves.length > 0) return blockMoves[Math.floor(Math.random() * blockMoves.length)];
    }
    // 3. Otherwise random.
    return moves[Math.floor(Math.random() * moves.length)];
  },
};

export const hardBot: BotStrategy<NMMState, NMMMove> = {
  pickMove: (state) => pickBestMove(state, 3),
};

// re-exports used elsewhere
export { NUM_POINTS, isInMill };
