/**
 * Tak (simplified) system bots.
 *
 *   easy   → random legal placement.
 *   medium → 1-ply: prefer FLAT placements that shorten own road-distance;
 *            use WALL placements to block opponent road-distance.
 *   hard   → depth-2 negamax with road-distance eval.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  SIZE,
  TOTAL_CELLS,
  applyMove,
  cellIdx,
  checkResult,
  findRoad,
  inBounds,
  legalMoves,
  opposite,
  type Cell,
  type PlayerId,
  type TakMove,
  type TakState,
} from "./game";

const WIN_SCORE = 1_000_000;

/**
 * Shortest road-distance for `side` — minimum number of EMPTY cells they
 * would need to fill (with flats) to complete a road in either
 * orientation. Walls (own or opponent) and opponent flats are impassable.
 * Own flats count as zero cost; empty cells count as 1.
 */
function roadDistance(cells: Cell[], side: PlayerId): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (const orientation of ["topbot", "leftright"] as const) {
    const dist = new Int32Array(TOTAL_CELLS).fill(Number.MAX_SAFE_INTEGER);
    const queue: number[] = [];
    // Dijkstra-like with bounded weights (0 or 1).
    const seed = (r: number, c: number) => {
      const idx = cellIdx(r, c);
      const cell = cells[idx];
      if (cell && (cell.side !== side || cell.kind !== "F")) return; // impassable
      const cost = cell?.side === side && cell?.kind === "F" ? 0 : 1;
      if (cost < dist[idx]) {
        dist[idx] = cost;
        queue.push(idx);
      }
    };
    if (orientation === "topbot") for (let c = 0; c < SIZE; c++) seed(0, c);
    else for (let r = 0; r < SIZE; r++) seed(r, 0);
    while (queue.length > 0) {
      queue.sort((a, b) => dist[a] - dist[b]);
      const cur = queue.shift()!;
      const r = Math.floor(cur / SIZE);
      const c = cur % SIZE;
      const onGoal = orientation === "topbot" ? r === SIZE - 1 : c === SIZE - 1;
      if (onGoal) {
        if (dist[cur] < best) best = dist[cur];
        continue;
      }
      for (const [dr, dc] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as const) {
        const nr = r + dr;
        const nc = c + dc;
        if (!inBounds(nr, nc)) continue;
        const ni = cellIdx(nr, nc);
        const cell = cells[ni];
        if (cell && (cell.side !== side || cell.kind !== "F")) continue;
        const cost = cell?.side === side && cell?.kind === "F" ? 0 : 1;
        const nd = dist[cur] + cost;
        if (nd < dist[ni]) {
          dist[ni] = nd;
          queue.push(ni);
        }
      }
    }
  }
  return best;
}

function evaluate(state: TakState, root: PlayerId): number {
  const opp = opposite(root);
  const myDist = roadDistance(state.cells, root);
  const oppDist = roadDistance(state.cells, opp);
  if (myDist === 0) return WIN_SCORE / 2;
  if (oppDist === 0) return -WIN_SCORE / 2;
  return oppDist - myDist;
}

function negamax(state: TakState, depth: number, alpha: number, beta: number, root: PlayerId): number {
  const r = checkResult(state);
  if (r.status === "win") return r.winner === root ? WIN_SCORE - (1000 - depth) : -WIN_SCORE + (1000 - depth);
  if (r.status === "draw") return 0;
  if (depth === 0) return evaluate(state, root) * (state.turn === root ? 1 : -1);

  // Trim search: rank moves by eval after they're applied, keep top 14.
  const moves = legalMoves(state);
  if (moves.length === 0) return 0;
  const ordered = moves
    .map((m) => ({ m, score: evaluate(applyMove(state, m), state.turn) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 14)
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

function pickBestMove(state: TakState, depth: number): TakMove {
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

export const easyBot: BotStrategy<TakState, TakMove> = {
  pickMove: (state) => {
    const moves = legalMoves(state);
    if (moves.length === 0) throw new Error("easyBot: no moves");
    return moves[Math.floor(Math.random() * moves.length)];
  },
};

export const mediumBot: BotStrategy<TakState, TakMove> = {
  pickMove: (state) => {
    const moves = legalMoves(state);
    if (moves.length === 0) throw new Error("mediumBot: no moves");
    const me = state.turn;
    let best = moves[0];
    let bestScore = -Infinity;
    for (const m of moves) {
      const next = applyMove(state, m);
      const score = evaluate(next, me);
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  },
};

export const hardBot: BotStrategy<TakState, TakMove> = {
  // Depth 3 — Tak's branching is high (place vs move, every stack
  // arrangement), but road-completion threats are local and depth 3
  // is where the road-blocking + bridge-extension tactics start to
  // emerge.
  pickMove: (state) => pickBestMove(state, 3),
};
