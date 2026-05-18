/**
 * Quoridor — pure rules engine + boardgame.io game definition.
 *
 * 9×9 grid. Each player has a pawn and 10 walls. On your turn you either
 * MOVE your pawn one orthogonal step OR PLACE a wall.
 *
 *   - Player 0 starts at (0, 4) (top row middle) and must reach row 8.
 *   - Player 1 starts at (8, 4) (bottom row middle) and must reach row 0.
 *
 * Walls are 2-cell segments placed BETWEEN cells. A wall blocks movement
 * across the gap it occupies but two perpendicular walls can't share a
 * center intersection. Crucially, a wall placement is illegal if it
 * would leave EITHER pawn with no path to its goal.
 *
 * Wall coordinate system: 8×8 lattice of "slot" intersections. Each slot
 * (sr, sc) with 0 ≤ sr, sc ≤ 7 can host either:
 *
 *   - A HORIZONTAL wall spanning columns sc..sc+1 at the gap between
 *     rows sr and sr+1. Blocks cell (sr, sc)↔(sr+1, sc) AND
 *     (sr, sc+1)↔(sr+1, sc+1).
 *
 *   - A VERTICAL wall spanning rows sr..sr+1 at the gap between columns
 *     sc and sc+1. Blocks (sr, sc)↔(sr, sc+1) AND (sr+1, sc)↔(sr+1, sc+1).
 *
 * Two walls at the same slot in different orientations CROSS — only one
 * allowed per slot.
 *
 * MVP note: this implementation OMITS the "jump over an adjacent
 * opponent pawn" rule for simplicity. A move that would land on the
 * opponent's cell is treated as illegal; you must go around. The full
 * Quoridor jump rule is a known extension and can be added in a future
 * iteration without breaking the engine shape.
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const SIZE = 9;
export const WALL_SLOTS = SIZE - 1; // 8
export const WALLS_PER_PLAYER = 10;

export type PlayerId = "0" | "1";
export type WallType = "h" | "v";

export interface PawnPos {
  row: number;
  col: number;
}

export interface QuoridorMove {
  /** "pawn" = move the pawn; "wall" = place a wall. */
  kind: "pawn" | "wall";
  /** for kind="pawn": destination cell */
  to?: { row: number; col: number };
  /** for kind="wall": slot + orientation */
  wall?: { type: WallType; row: number; col: number };
}

export interface QuoridorState {
  pawns: { "0": PawnPos; "1": PawnPos };
  /** hWalls[sr][sc] = true if a horizontal wall exists at slot (sr, sc). */
  hWalls: boolean[]; // length WALL_SLOTS * WALL_SLOTS (row-major)
  vWalls: boolean[]; // same
  wallsLeft: { "0": number; "1": number };
  turn: PlayerId;
  lastMove: QuoridorMove | null;
}

export type QuoridorResult =
  | { status: "ongoing" }
  | { status: "win"; winner: PlayerId };

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

export function cellIdx(row: number, col: number): number {
  return row * SIZE + col;
}
export function wallIdx(row: number, col: number): number {
  return row * WALL_SLOTS + col;
}
export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < SIZE && col >= 0 && col < SIZE;
}
export function inWallBounds(row: number, col: number): boolean {
  return row >= 0 && row < WALL_SLOTS && col >= 0 && col < WALL_SLOTS;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function startingState(): QuoridorState {
  return {
    pawns: { "0": { row: 0, col: 4 }, "1": { row: 8, col: 4 } },
    hWalls: Array<boolean>(WALL_SLOTS * WALL_SLOTS).fill(false),
    vWalls: Array<boolean>(WALL_SLOTS * WALL_SLOTS).fill(false),
    wallsLeft: { "0": WALLS_PER_PLAYER, "1": WALLS_PER_PLAYER },
    turn: "0",
    lastMove: null,
  };
}

export function cloneState(s: QuoridorState): QuoridorState {
  return {
    pawns: {
      "0": { row: s.pawns["0"].row, col: s.pawns["0"].col },
      "1": { row: s.pawns["1"].row, col: s.pawns["1"].col },
    },
    hWalls: s.hWalls.slice(),
    vWalls: s.vWalls.slice(),
    wallsLeft: { "0": s.wallsLeft["0"], "1": s.wallsLeft["1"] },
    turn: s.turn,
    lastMove: s.lastMove ? { ...s.lastMove } : null,
  };
}

export function opposite(p: PlayerId): PlayerId {
  return p === "0" ? "1" : "0";
}

export function goalRowFor(p: PlayerId): number {
  return p === "0" ? SIZE - 1 : 0;
}

// ---------------------------------------------------------------------------
// Wall blocking
// ---------------------------------------------------------------------------

/**
 * Returns true if there's a wall between adjacent cells (ar, ac) and
 * (br, bc). Cells must be orthogonally adjacent; otherwise the answer
 * is meaningless. Used by pathfinding + move validation.
 */
function isBlocked(state: QuoridorState, ar: number, ac: number, br: number, bc: number): boolean {
  if (ar === br) {
    // Horizontal movement — check vertical walls in the slot between them.
    const c = Math.min(ac, bc); // slot column = the smaller cell column
    // A vertical wall at slot (r, c) blocks rows r and r+1 across columns c and c+1.
    if (ar > 0 && inWallBounds(ar - 1, c) && state.vWalls[wallIdx(ar - 1, c)]) return true;
    if (ar < SIZE - 1 && inWallBounds(ar, c) && state.vWalls[wallIdx(ar, c)]) return true;
    return false;
  }
  // Vertical movement — check horizontal walls.
  const r = Math.min(ar, br);
  if (ac > 0 && inWallBounds(r, ac - 1) && state.hWalls[wallIdx(r, ac - 1)]) return true;
  if (ac < SIZE - 1 && inWallBounds(r, ac) && state.hWalls[wallIdx(r, ac)]) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Pawn moves
// ---------------------------------------------------------------------------

/**
 * Returns the orthogonally adjacent cells the pawn at (r, c) can step
 * into. Filters by wall blocking AND by opponent occupancy (simple
 * variant — no jumping).
 */
export function pawnMoveTargets(state: QuoridorState, side: PlayerId): PawnPos[] {
  const { row: r, col: c } = state.pawns[side];
  const opp = state.pawns[opposite(side)];
  const out: PawnPos[] = [];
  for (const [dr, dc] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    const nr = r + dr;
    const nc = c + dc;
    if (!inBounds(nr, nc)) continue;
    if (nr === opp.row && nc === opp.col) continue; // simple no-jump rule
    if (isBlocked(state, r, c, nr, nc)) continue;
    out.push({ row: nr, col: nc });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wall validation: no overlap, no crossing, and pathfinding holds
// ---------------------------------------------------------------------------

function wallExistsAt(state: QuoridorState, type: WallType, row: number, col: number): boolean {
  if (!inWallBounds(row, col)) return false;
  const idx = wallIdx(row, col);
  return type === "h" ? state.hWalls[idx] : state.vWalls[idx];
}

/**
 * True if placing a wall of `type` at slot (row, col) would overlap with
 * another wall of the same orientation (sharing a cell endpoint) or
 * cross a perpendicular wall.
 */
function wallConflict(state: QuoridorState, type: WallType, row: number, col: number): boolean {
  if (!inWallBounds(row, col)) return true;
  // Same slot, same orientation
  if (wallExistsAt(state, type, row, col)) return true;
  // Perpendicular wall at the same slot crosses through the intersection
  const perpType: WallType = type === "h" ? "v" : "h";
  if (wallExistsAt(state, perpType, row, col)) return true;
  // Horizontal wall overlap: another horizontal at (row, col-1) or (row, col+1)
  if (type === "h") {
    if (wallExistsAt(state, "h", row, col - 1)) return true;
    if (wallExistsAt(state, "h", row, col + 1)) return true;
  } else {
    if (wallExistsAt(state, "v", row - 1, col)) return true;
    if (wallExistsAt(state, "v", row + 1, col)) return true;
  }
  return false;
}

/**
 * BFS from `pawn` toward `goalRow`. Returns true if a path exists in the
 * given state.
 */
export function hasPathToGoal(state: QuoridorState, pawn: PawnPos, goalRow: number): boolean {
  const visited = new Uint8Array(SIZE * SIZE);
  const queue: number[] = [cellIdx(pawn.row, pawn.col)];
  visited[queue[0]] = 1;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const r = Math.floor(cur / SIZE);
    const c = cur % SIZE;
    if (r === goalRow) return true;
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
      if (visited[ni]) continue;
      if (isBlocked(state, r, c, nr, nc)) continue;
      visited[ni] = 1;
      queue.push(ni);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Move legality + apply
// ---------------------------------------------------------------------------

export function isLegalMove(state: QuoridorState, move: QuoridorMove): boolean {
  if (move.kind === "pawn") {
    if (!move.to) return false;
    return pawnMoveTargets(state, state.turn).some(
      (t) => t.row === move.to!.row && t.col === move.to!.col,
    );
  }
  // Wall move
  if (!move.wall) return false;
  if (state.wallsLeft[state.turn] <= 0) return false;
  const { type, row, col } = move.wall;
  if (type !== "h" && type !== "v") return false;
  if (!inWallBounds(row, col)) return false;
  if (wallConflict(state, type, row, col)) return false;
  // Try the placement and verify both pawns still have a path.
  const probe = cloneState(state);
  if (type === "h") probe.hWalls[wallIdx(row, col)] = true;
  else probe.vWalls[wallIdx(row, col)] = true;
  if (!hasPathToGoal(probe, probe.pawns["0"], goalRowFor("0"))) return false;
  if (!hasPathToGoal(probe, probe.pawns["1"], goalRowFor("1"))) return false;
  return true;
}

export function legalMoves(state: QuoridorState): QuoridorMove[] {
  const out: QuoridorMove[] = [];
  // Pawn moves
  for (const t of pawnMoveTargets(state, state.turn)) {
    out.push({ kind: "pawn", to: t });
  }
  // Wall placements (only if we have walls left)
  if (state.wallsLeft[state.turn] > 0) {
    for (let r = 0; r < WALL_SLOTS; r++) {
      for (let c = 0; c < WALL_SLOTS; c++) {
        for (const type of ["h", "v"] as const) {
          const m: QuoridorMove = { kind: "wall", wall: { type, row: r, col: c } };
          if (isLegalMove(state, m)) out.push(m);
        }
      }
    }
  }
  return out;
}

export function applyMove(state: QuoridorState, move: QuoridorMove): QuoridorState {
  if (!isLegalMove(state, move)) {
    throw new Error(`illegal quoridor move ${JSON.stringify(move)}`);
  }
  const next = cloneState(state);
  if (move.kind === "pawn") {
    next.pawns[state.turn] = { row: move.to!.row, col: move.to!.col };
  } else {
    const { type, row, col } = move.wall!;
    if (type === "h") next.hWalls[wallIdx(row, col)] = true;
    else next.vWalls[wallIdx(row, col)] = true;
    next.wallsLeft[state.turn] -= 1;
  }
  next.lastMove = { ...move };
  next.turn = opposite(state.turn);
  return next;
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

export function checkResult(state: QuoridorState): QuoridorResult {
  if (state.pawns["0"].row === goalRowFor("0")) return { status: "win", winner: "0" };
  if (state.pawns["1"].row === goalRowFor("1")) return { status: "win", winner: "1" };
  return { status: "ongoing" };
}

// ---------------------------------------------------------------------------
// boardgame.io
// ---------------------------------------------------------------------------

export const game: Game<QuoridorState> = {
  name: "quoridor",
  setup: () => startingState(),
  turn: { minMoves: 1, maxMoves: 1 },
  moves: {
    play: ({ G, playerID }, raw: unknown) => {
      if (G.turn !== playerID) return INVALID_MOVE;
      const arg = raw as {
        kind?: unknown;
        to?: { row?: unknown; col?: unknown };
        wall?: { type?: unknown; row?: unknown; col?: unknown };
      };
      if (arg.kind !== "pawn" && arg.kind !== "wall") return INVALID_MOVE;
      const move: QuoridorMove = { kind: arg.kind };
      if (arg.kind === "pawn") {
        if (!arg.to) return INVALID_MOVE;
        const row = Number(arg.to.row);
        const col = Number(arg.to.col);
        if (!Number.isInteger(row) || !Number.isInteger(col)) return INVALID_MOVE;
        move.to = { row, col };
      } else {
        if (!arg.wall || (arg.wall.type !== "h" && arg.wall.type !== "v")) return INVALID_MOVE;
        const row = Number(arg.wall.row);
        const col = Number(arg.wall.col);
        if (!Number.isInteger(row) || !Number.isInteger(col)) return INVALID_MOVE;
        move.wall = { type: arg.wall.type, row, col };
      }
      if (!isLegalMove(G, move)) return INVALID_MOVE;
      const next = applyMove(G, move);
      G.pawns = next.pawns;
      G.hWalls = next.hWalls;
      G.vWalls = next.vWalls;
      G.wallsLeft = next.wallsLeft;
      G.turn = next.turn;
      G.lastMove = next.lastMove;
    },
  },
  endIf: ({ G }) => {
    const r = checkResult(G);
    if (r.status === "win") return { winner: r.winner };
  },
};
