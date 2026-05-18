/**
 * Hex system bots.
 *
 *   easy   → random legal cell.
 *   medium → 1-ply: take the cell that maximizes our "connection
 *            strength" minus opponent's after the move. Connection
 *            strength is measured via shortest-path distance from the
 *            player's two edges (lower is better).
 *   hard   → depth-2 negamax + alpha-beta over the top-K active cells
 *            (cells adjacent to existing stones). The eval is shortest-
 *            path-based, so a stone that bridges two clusters scores
 *            highly without us computing chains explicitly.
 *
 * Notes: Hex is a hard game for shallow bots — no fast tactical
 * patterns dominate the way they do in Gomoku. Without a strong
 * positional model these bots make reasonable moves but are easily
 * beatable by a thoughtful human.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  SIZE,
  TOTAL_CELLS,
  applyMove,
  checkResult,
  inBounds,
  indexOf,
  legalMoves,
  neighborsOf,
  opposite,
  type Board,
  type HexMove,
  type HexState,
  type Side,
} from "./game";

const WIN_SCORE = 1_000_000;

/**
 * Shortest path for `side` from their starting edge to their goal edge,
 * treating own stones as cost 0 and empty cells as cost 1, opponent
 * stones as impassable. Lower is better. Used as the eval.
 */
function shortestPathLen(board: Board, side: Side): number {
  // Dijkstra from a virtual source connected to the start edge.
  const dist = new Int32Array(TOTAL_CELLS).fill(Number.MAX_SAFE_INTEGER);
  // Min-heap by dist using a simple array sort (board is small).
  const queue: Array<[number, number]> = []; // [dist, idx]

  const seed = (r: number, c: number) => {
    const idx = indexOf(r, c);
    if (board[idx] === opposite(side)) return;
    const cost = board[idx] === side ? 0 : 1;
    if (cost < dist[idx]) {
      dist[idx] = cost;
      queue.push([cost, idx]);
    }
  };

  if (side === "R") {
    for (let c = 0; c < SIZE; c++) seed(0, c);
  } else {
    for (let r = 0; r < SIZE; r++) seed(r, 0);
  }

  let best = Number.MAX_SAFE_INTEGER;
  while (queue.length > 0) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, idx] = queue.shift()!;
    if (d > dist[idx]) continue;
    const r = Math.floor(idx / SIZE);
    const c = idx % SIZE;
    const onGoal = side === "R" ? r === SIZE - 1 : c === SIZE - 1;
    if (onGoal) {
      best = Math.min(best, d);
      continue;
    }
    for (const [nr, nc] of neighborsOf(r, c)) {
      const ni = indexOf(nr, nc);
      const cell = board[ni];
      if (cell === opposite(side)) continue;
      const cost = cell === side ? 0 : 1;
      const nd = d + cost;
      if (nd < dist[ni]) {
        dist[ni] = nd;
        queue.push([nd, ni]);
      }
    }
  }
  return best;
}

/**
 * Eval from `root`'s POV. We reward lower own-distance and penalize
 * lower opponent-distance. If the opponent has already connected
 * (distance 0 implying a winning chain) we score very low; if we have,
 * we score very high.
 */
function evaluate(state: HexState, root: Side): number {
  const myDist = shortestPathLen(state.board, root);
  const oppDist = shortestPathLen(state.board, opposite(root));
  // A connected position has shortestPath = 0 (no empty cells needed).
  if (myDist === 0) return WIN_SCORE / 2;
  if (oppDist === 0) return -WIN_SCORE / 2;
  return oppDist - myDist;
}

/** Cells adjacent (1 step) to any non-empty cell, plus the center cell as a fallback. */
function activeCells(board: Board): HexMove[] {
  const seen = new Uint8Array(TOTAL_CELLS);
  const out: HexMove[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[indexOf(r, c)] === "") continue;
      for (const [nr, nc] of neighborsOf(r, c)) {
        const ni = indexOf(nr, nc);
        if (board[ni] !== "" || seen[ni]) continue;
        seen[ni] = 1;
        out.push({ row: nr, col: nc });
      }
    }
  }
  if (out.length === 0) {
    const mid = Math.floor(SIZE / 2);
    out.push({ row: mid, col: mid });
  }
  return out;
}

function orderMoves(state: HexState, moves: HexMove[]): HexMove[] {
  return moves
    .map((m) => {
      const next = applyMove(state, m);
      return { m, score: evaluate(next, state.turn) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10) // top 10 — keep the search shallow but focused
    .map((x) => x.m);
}

function negamax(state: HexState, depth: number, alpha: number, beta: number): number {
  const r = checkResult(state);
  if (r.status === "win") return -WIN_SCORE + (1000 - depth);
  if (depth === 0) return evaluate(state, state.turn);
  const moves = orderMoves(state, activeCells(state.board));
  let best = -Infinity;
  for (const m of moves) {
    const next = applyMove(state, m);
    const score = -negamax(next, depth - 1, -beta, -alpha);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function pickBestMove(state: HexState, depth: number): HexMove {
  const candidates = activeCells(state.board);
  // First-move special: play the center.
  if (state.moveCount === 0) {
    const mid = Math.floor(SIZE / 2);
    return { row: mid, col: mid };
  }
  if (candidates.length === 0) throw new Error("pickBestMove: no candidates");
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const m of orderMoves(state, candidates)) {
    const next = applyMove(state, m);
    const score = -negamax(next, depth - 1, -Infinity, Infinity);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

export const easyBot: BotStrategy<HexState, HexMove> = {
  pickMove: (state) => {
    const moves = legalMoves(state);
    if (moves.length === 0) throw new Error("easyBot: no moves");
    return moves[Math.floor(Math.random() * moves.length)];
  },
};

export const mediumBot: BotStrategy<HexState, HexMove> = {
  pickMove: (state) => {
    if (state.moveCount === 0) {
      const mid = Math.floor(SIZE / 2);
      return { row: mid, col: mid };
    }
    const me = state.turn;
    const moves = activeCells(state.board);
    let best = moves[0];
    let bestScore = -Infinity;
    for (const m of moves) {
      const next = applyMove(state, m);
      const s = evaluate(next, me);
      if (s > bestScore) {
        bestScore = s;
        best = m;
      }
    }
    return best;
  },
};

export const hardBot: BotStrategy<HexState, HexMove> = {
  pickMove: (state) => pickBestMove(state, 2),
};

// Compatibility re-exports.
export { inBounds };
