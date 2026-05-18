/**
 * Hex — pure rules engine + boardgame.io game definition.
 *
 * 11×11 rhombic hexagonal grid. Two players: Red ("R") owns the top
 * and bottom edges; Blue ("B") owns the left and right edges. On your
 * turn place a single stone of your color on any empty cell. The first
 * to form an unbroken chain of stones connecting their two opposite
 * edges wins. Topologically, Hex cannot end in a draw.
 *
 * Board representation: flat Cell[121], row-major. Cells: "" / "R" / "B".
 *
 * Hex neighbours (axial-ish, for a rhombic grid):
 *   (r, c) neighbours: (r-1, c), (r-1, c+1), (r, c-1), (r, c+1), (r+1, c-1), (r+1, c)
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const SIZE = 11;
export const TOTAL_CELLS = SIZE * SIZE;

export type Side = "R" | "B";
export type Cell = Side | "";
export type Board = Cell[];

export interface HexMove {
  row: number;
  col: number;
}

export interface HexState {
  board: Board;
  turn: Side;
  lastMove: { row: number; col: number; player: Side } | null;
  moveCount: number;
}

export type HexResult =
  | { status: "ongoing" }
  | { status: "win"; winner: Side; line: ReadonlyArray<readonly [number, number]> };

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

export function indexOf(row: number, col: number): number {
  return row * SIZE + col;
}
export function rowColOf(index: number): [number, number] {
  return [Math.floor(index / SIZE), index % SIZE];
}
export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < SIZE && col >= 0 && col < SIZE;
}

const NEIGHBOR_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0],
];

export function neighborsOf(row: number, col: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [dr, dc] of NEIGHBOR_DELTAS) {
    const nr = row + dr;
    const nc = col + dc;
    if (inBounds(nr, nc)) out.push([nr, nc]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function emptyBoard(): Board {
  return Array<Cell>(TOTAL_CELLS).fill("");
}

export function startingState(): HexState {
  return {
    board: emptyBoard(),
    turn: "R",
    lastMove: null,
    moveCount: 0,
  };
}

export function cloneState(s: HexState): HexState {
  return {
    board: s.board.slice() as Board,
    turn: s.turn,
    lastMove: s.lastMove ? { ...s.lastMove } : null,
    moveCount: s.moveCount,
  };
}

export function opposite(side: Side): Side {
  return side === "R" ? "B" : "R";
}

// ---------------------------------------------------------------------------
// Move legality
// ---------------------------------------------------------------------------

export function isLegalMove(board: Board, row: number, col: number): boolean {
  return inBounds(row, col) && board[indexOf(row, col)] === "";
}

export function legalMoves(state: HexState): HexMove[] {
  const out: HexMove[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (state.board[indexOf(r, c)] === "") out.push({ row: r, col: c });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Win detection via BFS from one edge to the other
// ---------------------------------------------------------------------------

/**
 * Returns the connecting line (a path of cells) if `side` has connected
 * their two edges, else null.
 *
 *   - Red ("R") connects ROW 0 to ROW SIZE-1 (top to bottom).
 *   - Blue ("B") connects COL 0 to COL SIZE-1 (left to right).
 */
function findWinningLine(board: Board, side: Side): ReadonlyArray<readonly [number, number]> | null {
  const visited = new Uint8Array(TOTAL_CELLS);
  const parent = new Int16Array(TOTAL_CELLS).fill(-1);
  const queue: number[] = [];

  // Seed with all stones of `side` on the starting edge.
  if (side === "R") {
    for (let c = 0; c < SIZE; c++) {
      const idx = indexOf(0, c);
      if (board[idx] === "R") {
        visited[idx] = 1;
        queue.push(idx);
      }
    }
  } else {
    for (let r = 0; r < SIZE; r++) {
      const idx = indexOf(r, 0);
      if (board[idx] === "B") {
        visited[idx] = 1;
        queue.push(idx);
      }
    }
  }

  let goalIdx = -1;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const [r, c] = rowColOf(cur);
    const onGoalEdge = side === "R" ? r === SIZE - 1 : c === SIZE - 1;
    if (onGoalEdge) {
      goalIdx = cur;
      break;
    }
    for (const [nr, nc] of neighborsOf(r, c)) {
      const ni = indexOf(nr, nc);
      if (visited[ni]) continue;
      if (board[ni] !== side) continue;
      visited[ni] = 1;
      parent[ni] = cur;
      queue.push(ni);
    }
  }
  if (goalIdx < 0) return null;
  // Reconstruct the path back to the start.
  const path: Array<[number, number]> = [];
  let cur: number = goalIdx;
  while (cur >= 0) {
    path.push(rowColOf(cur));
    cur = parent[cur];
  }
  return path.reverse();
}

export function checkResult(state: HexState): HexResult {
  // After the most recent move, only that player could have potentially
  // completed a chain — but checking both is cheap and keeps this safe
  // when constructing positions in tests.
  for (const side of ["R", "B"] as const) {
    const line = findWinningLine(state.board, side);
    if (line) return { status: "win", winner: side, line };
  }
  return { status: "ongoing" };
}

// ---------------------------------------------------------------------------
// Apply move
// ---------------------------------------------------------------------------

export function applyMove(state: HexState, move: HexMove): HexState {
  if (!isLegalMove(state.board, move.row, move.col)) {
    throw new Error(`illegal hex move at (${move.row}, ${move.col})`);
  }
  const next = cloneState(state);
  next.board[indexOf(move.row, move.col)] = state.turn;
  next.lastMove = { row: move.row, col: move.col, player: state.turn };
  next.moveCount += 1;
  next.turn = opposite(state.turn);
  return next;
}

// ---------------------------------------------------------------------------
// boardgame.io
// ---------------------------------------------------------------------------

export const game: Game<HexState> = {
  name: "hex",
  setup: () => startingState(),
  turn: { minMoves: 1, maxMoves: 1 },
  moves: {
    place: ({ G, playerID }, raw: unknown) => {
      const expectedSide: Side = playerID === "0" ? "R" : "B";
      if (G.turn !== expectedSide) return INVALID_MOVE;
      const arg = raw as { row?: unknown; col?: unknown };
      const row = Number(arg.row);
      const col = Number(arg.col);
      if (!Number.isInteger(row) || !Number.isInteger(col)) return INVALID_MOVE;
      if (!isLegalMove(G.board, row, col)) return INVALID_MOVE;
      G.board[indexOf(row, col)] = expectedSide;
      G.lastMove = { row, col, player: expectedSide };
      G.moveCount += 1;
      G.turn = opposite(expectedSide);
    },
  },
  endIf: ({ G }) => {
    const r = checkResult(G);
    if (r.status === "win") return { winner: r.winner === "R" ? "0" : "1" };
  },
};
