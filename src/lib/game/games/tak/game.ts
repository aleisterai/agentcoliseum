/**
 * Tak (simplified, 5×5) — pure rules engine + boardgame.io game definition.
 *
 * This MVP implements a stripped-down variant of Tak focused on its
 * signature mechanic: road-building with two piece types (flat + wall).
 *
 *   - 5×5 grid, single layer per cell (no stacks).
 *   - Each player has 21 stones. They may be placed as FLAT or WALL.
 *   - Each turn: place one stone (any combination of flat / wall) on an
 *     empty cell. No moves; no stacks.
 *   - WIN: form an unbroken orthogonal road of your **flats** from one
 *     side of the board to the opposite side (top↔bottom OR left↔right).
 *     Walls do NOT count for road purposes — they block the opponent.
 *   - DRAW: both sides run out of stones with no road.
 *
 * Stacks, capstones, and movement are deferred to a future iteration.
 *
 * Move payload: `{ to: { row, col }, kind: "F" | "W" }`.
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const SIZE = 5;
export const TOTAL_CELLS = SIZE * SIZE;
export const STONES_PER_PLAYER = 21;

export type PlayerId = "0" | "1";
export type PieceKind = "F" | "W"; // Flat / Wall

export interface TakPiece {
  side: PlayerId;
  kind: PieceKind;
}

export type Cell = TakPiece | null;

export interface TakMove {
  to: { row: number; col: number };
  kind: PieceKind;
}

export interface TakState {
  cells: Cell[]; // length 25, row-major
  turn: PlayerId;
  stonesLeft: { "0": number; "1": number };
  lastMove: TakMove | null;
}

export type TakResult =
  | { status: "ongoing" }
  | { status: "win"; winner: PlayerId; line: ReadonlyArray<readonly [number, number]> }
  | { status: "draw" };

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

export function cellIdx(row: number, col: number): number {
  return row * SIZE + col;
}
export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < SIZE && col >= 0 && col < SIZE;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function startingState(): TakState {
  return {
    cells: Array<Cell>(TOTAL_CELLS).fill(null),
    turn: "0",
    stonesLeft: { "0": STONES_PER_PLAYER, "1": STONES_PER_PLAYER },
    lastMove: null,
  };
}

export function cloneState(s: TakState): TakState {
  return {
    cells: s.cells.map((c) => (c ? { ...c } : null)),
    turn: s.turn,
    stonesLeft: { ...s.stonesLeft },
    lastMove: s.lastMove ? { ...s.lastMove } : null,
  };
}

export function opposite(p: PlayerId): PlayerId {
  return p === "0" ? "1" : "0";
}

// ---------------------------------------------------------------------------
// Move legality
// ---------------------------------------------------------------------------

export function isLegalMove(state: TakState, move: TakMove): boolean {
  if (!inBounds(move.to.row, move.to.col)) return false;
  if (state.cells[cellIdx(move.to.row, move.to.col)] !== null) return false;
  if (move.kind !== "F" && move.kind !== "W") return false;
  if (state.stonesLeft[state.turn] <= 0) return false;
  return true;
}

export function legalMoves(state: TakState): TakMove[] {
  const out: TakMove[] = [];
  if (state.stonesLeft[state.turn] <= 0) return out;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (state.cells[cellIdx(r, c)] !== null) continue;
      out.push({ to: { row: r, col: c }, kind: "F" });
      out.push({ to: { row: r, col: c }, kind: "W" });
    }
  }
  return out;
}

export function applyMove(state: TakState, move: TakMove): TakState {
  if (!isLegalMove(state, move)) {
    throw new Error(`illegal tak move ${JSON.stringify(move)}`);
  }
  const next = cloneState(state);
  const me = state.turn;
  next.cells[cellIdx(move.to.row, move.to.col)] = { side: me, kind: move.kind };
  next.stonesLeft[me] -= 1;
  next.lastMove = { ...move };
  next.turn = opposite(me);
  return next;
}

// ---------------------------------------------------------------------------
// Road detection
// ---------------------------------------------------------------------------

/**
 * BFS-based road search for `side`'s FLATS only (walls don't count).
 * A road connects either:
 *   - row 0 to row SIZE-1 (top↔bottom), OR
 *   - col 0 to col SIZE-1 (left↔right).
 *
 * Returns the path if one exists for `side`, else null.
 */
export function findRoad(
  cells: Cell[],
  side: PlayerId,
): ReadonlyArray<readonly [number, number]> | null {
  // Try both orientations.
  for (const orientation of ["topbot", "leftright"] as const) {
    const visited = new Uint8Array(TOTAL_CELLS);
    const parent = new Int16Array(TOTAL_CELLS).fill(-1);
    const queue: number[] = [];
    if (orientation === "topbot") {
      for (let c = 0; c < SIZE; c++) {
        const idx = cellIdx(0, c);
        if (cells[idx]?.side === side && cells[idx]?.kind === "F") {
          visited[idx] = 1;
          queue.push(idx);
        }
      }
    } else {
      for (let r = 0; r < SIZE; r++) {
        const idx = cellIdx(r, 0);
        if (cells[idx]?.side === side && cells[idx]?.kind === "F") {
          visited[idx] = 1;
          queue.push(idx);
        }
      }
    }
    let goalIdx = -1;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const r = Math.floor(cur / SIZE);
      const c = cur % SIZE;
      const onGoalEdge = orientation === "topbot" ? r === SIZE - 1 : c === SIZE - 1;
      if (onGoalEdge) {
        goalIdx = cur;
        break;
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
        if (visited[ni]) continue;
        const cell = cells[ni];
        if (!cell || cell.side !== side || cell.kind !== "F") continue;
        visited[ni] = 1;
        parent[ni] = cur;
        queue.push(ni);
      }
    }
    if (goalIdx >= 0) {
      const path: Array<[number, number]> = [];
      let cur: number = goalIdx;
      while (cur >= 0) {
        path.push([Math.floor(cur / SIZE), cur % SIZE]);
        cur = parent[cur];
      }
      return path.reverse();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

export function checkResult(state: TakState): TakResult {
  for (const side of ["0", "1"] as const) {
    const road = findRoad(state.cells, side);
    if (road) return { status: "win", winner: side, line: road };
  }
  // Out of stones — draw.
  if (state.stonesLeft["0"] === 0 && state.stonesLeft["1"] === 0) {
    return { status: "draw" };
  }
  return { status: "ongoing" };
}

// ---------------------------------------------------------------------------
// boardgame.io
// ---------------------------------------------------------------------------

export const game: Game<TakState> = {
  name: "tak",
  setup: () => startingState(),
  turn: { minMoves: 1, maxMoves: 1 },
  moves: {
    place: ({ G, playerID }, raw: unknown) => {
      if (G.turn !== playerID) return INVALID_MOVE;
      const arg = raw as { to?: { row?: unknown; col?: unknown }; kind?: unknown };
      if (!arg.to) return INVALID_MOVE;
      const row = Number(arg.to.row);
      const col = Number(arg.to.col);
      if (!Number.isInteger(row) || !Number.isInteger(col)) return INVALID_MOVE;
      if (arg.kind !== "F" && arg.kind !== "W") return INVALID_MOVE;
      const move: TakMove = { to: { row, col }, kind: arg.kind };
      if (!isLegalMove(G, move)) return INVALID_MOVE;
      const next = applyMove(G, move);
      G.cells = next.cells;
      G.turn = next.turn;
      G.stonesLeft = next.stonesLeft;
      G.lastMove = next.lastMove;
    },
  },
  endIf: ({ G }) => {
    const r = checkResult(G);
    if (r.status === "win") return { winner: r.winner };
    if (r.status === "draw") return { draw: true };
  },
};
