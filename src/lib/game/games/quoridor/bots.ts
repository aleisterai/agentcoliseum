/**
 * Quoridor system bots.
 *
 *   easy   → random legal move (pawn or wall).
 *   medium → "race forward, wall when ahead is blocked": pick the
 *            adjacent pawn step that reduces shortest-path to goal the
 *            most. If no pawn-move shortens the path, place a wall that
 *            increases opponent's shortest-path the most.
 *   hard   → depth-3 negamax over a restricted move set (pawn moves +
 *            top-12 walls by opponent-cost delta). Eval = own SP -
 *            opp SP + walls-on-hand bonus.
 *
 * Quoridor branching factor at start is ~12 (4 pawn + 64 valid walls
 * per orientation = 128 wall slots × 2 minus invalid). We need
 * aggressive pruning for any depth > 2.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  SIZE,
  WALL_SLOTS,
  applyMove,
  checkResult,
  cellIdx,
  goalRowFor,
  hasPathToGoal,
  legalMoves,
  pawnMoveTargets,
  opposite,
  inBounds,
  type QuoridorMove,
  type QuoridorState,
} from "./game";

const WIN_SCORE = 1_000_000;

/**
 * BFS shortest-path distance from `from` to any cell in `goalRow`. Wall
 * blocking is respected via the engine's isBlocked logic, encapsulated
 * inside hasPathToGoal — but we want the actual distance, so re-implement
 * the BFS here with hop counting.
 */
function shortestPathDistance(state: QuoridorState, from: { row: number; col: number }, goalRow: number): number {
  const visited = new Int16Array(SIZE * SIZE).fill(-1);
  const queue: number[] = [cellIdx(from.row, from.col)];
  visited[queue[0]] = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const r = Math.floor(cur / SIZE);
    const c = cur % SIZE;
    if (r === goalRow) return visited[cur];
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
      if (visited[ni] >= 0) continue;
      // Use the same blocking check by simulating a 1-step move.
      // hasPathToGoal internally uses isBlocked but isn't exported. We
      // re-derive blocking here by checking adjacent walls.
      // To avoid leaking the function, we use a quick local check:
      if (isBlockedLocal(state, r, c, nr, nc)) continue;
      visited[ni] = visited[cur] + 1;
      queue.push(ni);
    }
  }
  return Number.MAX_SAFE_INTEGER;
}

function isBlockedLocal(state: QuoridorState, ar: number, ac: number, br: number, bc: number): boolean {
  if (ar === br) {
    const c = Math.min(ac, bc);
    const inW = (r: number, cc: number) => r >= 0 && r < WALL_SLOTS && cc >= 0 && cc < WALL_SLOTS;
    if (ar > 0 && inW(ar - 1, c) && state.vWalls[(ar - 1) * WALL_SLOTS + c]) return true;
    if (ar < SIZE - 1 && inW(ar, c) && state.vWalls[ar * WALL_SLOTS + c]) return true;
    return false;
  }
  const r = Math.min(ar, br);
  const inW = (rr: number, cc: number) => rr >= 0 && rr < WALL_SLOTS && cc >= 0 && cc < WALL_SLOTS;
  if (ac > 0 && inW(r, ac - 1) && state.hWalls[r * WALL_SLOTS + (ac - 1)]) return true;
  if (ac < SIZE - 1 && inW(r, ac) && state.hWalls[r * WALL_SLOTS + ac]) return true;
  return false;
}

function evaluate(state: QuoridorState, root: "0" | "1"): number {
  const opp = opposite(root);
  const myDist = shortestPathDistance(state, state.pawns[root], goalRowFor(root));
  const oppDist = shortestPathDistance(state, state.pawns[opp], goalRowFor(opp));
  const wallBonus = state.wallsLeft[root] - state.wallsLeft[opp];
  return (oppDist - myDist) * 10 + wallBonus;
}

function negamax(state: QuoridorState, depth: number, alpha: number, beta: number, root: "0" | "1"): number {
  const r = checkResult(state);
  if (r.status === "win") return r.winner === root ? WIN_SCORE - (1000 - depth) : -WIN_SCORE + (1000 - depth);
  if (depth === 0) return evaluate(state, root) * (state.turn === root ? 1 : -1);

  // Restrict the search: pawn moves + only the top-12 wall placements by
  // how much they increase opponent SP.
  const pawnMoves: QuoridorMove[] = pawnMoveTargets(state, state.turn).map((t) => ({ kind: "pawn", to: t }));
  const wallMoves: QuoridorMove[] = [];
  if (state.wallsLeft[state.turn] > 0) {
    const opp = opposite(state.turn);
    const baseline = shortestPathDistance(state, state.pawns[opp], goalRowFor(opp));
    const candidates: Array<{ m: QuoridorMove; delta: number }> = [];
    for (let r = 0; r < WALL_SLOTS; r++) {
      for (let c = 0; c < WALL_SLOTS; c++) {
        for (const type of ["h", "v"] as const) {
          const m: QuoridorMove = { kind: "wall", wall: { type, row: r, col: c } };
          // Use legalMoves' implicit check by trying the apply (skip if illegal).
          try {
            const probe = applyMove(state, m);
            const newDist = shortestPathDistance(probe, probe.pawns[opp], goalRowFor(opp));
            if (newDist > baseline) {
              candidates.push({ m, delta: newDist - baseline });
            }
          } catch {
            /* illegal — skip */
          }
        }
      }
    }
    candidates.sort((a, b) => b.delta - a.delta);
    for (const cand of candidates.slice(0, 12)) wallMoves.push(cand.m);
  }
  const moves = [...pawnMoves, ...wallMoves];
  if (moves.length === 0) return -WIN_SCORE + (1000 - depth);

  let best = -Infinity;
  for (const m of moves) {
    const next = applyMove(state, m);
    const score = -negamax(next, depth - 1, -beta, -alpha, root);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function pickBestMove(state: QuoridorState, depth: number): QuoridorMove {
  const me = state.turn;
  const moves = legalMoves(state);
  if (moves.length === 0) throw new Error("pickBestMove: no moves");
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves.slice(0, 30)) {
    const next = applyMove(state, m);
    const score = -negamax(next, depth - 1, -Infinity, Infinity, me);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

export const easyBot: BotStrategy<QuoridorState, QuoridorMove> = {
  pickMove: (state) => {
    const moves = legalMoves(state);
    if (moves.length === 0) throw new Error("easyBot: no moves");
    return moves[Math.floor(Math.random() * moves.length)];
  },
};

export const mediumBot: BotStrategy<QuoridorState, QuoridorMove> = {
  pickMove: (state) => {
    // 1. Find the pawn step that lowers SP the most.
    const me = state.turn;
    const myGoal = goalRowFor(me);
    const baseline = shortestPathDistance(state, state.pawns[me], myGoal);
    let bestPawn: QuoridorMove | null = null;
    let bestDelta = 0;
    for (const t of pawnMoveTargets(state, me)) {
      const probe: QuoridorState = { ...state, pawns: { ...state.pawns, [me]: t } };
      const sp = shortestPathDistance(probe, t, myGoal);
      const delta = baseline - sp;
      if (delta > bestDelta) {
        bestDelta = delta;
        bestPawn = { kind: "pawn", to: t };
      }
    }
    if (bestPawn) return bestPawn;
    // 2. No SP-shortening pawn move — place a wall that hurts opp SP the most.
    if (state.wallsLeft[me] > 0) {
      const opp = opposite(me);
      const oppBaseline = shortestPathDistance(state, state.pawns[opp], goalRowFor(opp));
      let bestWall: QuoridorMove | null = null;
      let bestIncrease = 0;
      for (let r = 0; r < WALL_SLOTS; r++) {
        for (let c = 0; c < WALL_SLOTS; c++) {
          for (const type of ["h", "v"] as const) {
            const m: QuoridorMove = { kind: "wall", wall: { type, row: r, col: c } };
            try {
              const next = applyMove(state, m);
              const newDist = shortestPathDistance(next, next.pawns[opp], goalRowFor(opp));
              if (newDist - oppBaseline > bestIncrease) {
                bestIncrease = newDist - oppBaseline;
                bestWall = m;
              }
            } catch {
              /* illegal */
            }
          }
        }
      }
      if (bestWall) return bestWall;
    }
    // 3. Fallback — first legal move.
    const legal = legalMoves(state);
    return legal[0];
  },
};

export const hardBot: BotStrategy<QuoridorState, QuoridorMove> = {
  pickMove: (state) => pickBestMove(state, 3),
};

// Re-exports for symmetry with other bots.
export { hasPathToGoal };
