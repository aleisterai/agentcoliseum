/**
 * Gomoku (Five in a Row, free-style) — pure rules engine + boardgame.io def.
 *
 * 15×15 grid. Players are Black ("B") and White ("W"). Black moves first.
 * On your turn you place a single stone on an empty intersection. First
 * to form an unbroken line of FIVE stones (horizontal, vertical, or
 * diagonal) wins. Free-style rules: an overline (6+ in a row) also wins
 * — no special restrictions for the first player (Renju-style swap2 /
 * "no overline" rules are NOT enforced; free-style is what most bots
 * train on).
 *
 * Board representation: flat Cell[225], row-major. Cells: "" / "B" / "W".
 *
 * Move payload: { row, col } with row/col both integers 0–14.
 *
 * Termination: 5-in-a-row → that side wins. Board full with no winner =
 * draw (rare in practice; happens at ~225 moves).
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const SIZE = 15;
export const WIN_LEN = 5;

export type Side = "B" | "W";
export type Cell = Side | "";
export type Board = Cell[]; // length 225

export interface GomokuMove {
  row: number;
  col: number;
}

export interface GomokuState {
  board: Board;
  turn: Side;
  lastMove: { row: number; col: number; player: Side } | null;
  moveCount: number;
}

export type GomokuResult =
  | { status: "ongoing" }
  | { status: "win"; winner: Side; line: ReadonlyArray<readonly [number, number]> }
  | { status: "draw" };

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

export function emptyBoard(): Board {
  return Array<Cell>(SIZE * SIZE).fill("");
}

export function opposite(side: Side): Side {
  return side === "B" ? "W" : "B";
}

export function startingState(): GomokuState {
  return {
    board: emptyBoard(),
    turn: "B",
    lastMove: null,
    moveCount: 0,
  };
}

export function cloneState(s: GomokuState): GomokuState {
  return {
    board: s.board.slice() as Board,
    turn: s.turn,
    lastMove: s.lastMove ? { ...s.lastMove } : null,
    moveCount: s.moveCount,
  };
}

// ---------------------------------------------------------------------------
// Move legality + result
// ---------------------------------------------------------------------------

export function isLegalMove(board: Board, row: number, col: number): boolean {
  return inBounds(row, col) && board[indexOf(row, col)] === "";
}

export function legalMoves(state: GomokuState): GomokuMove[] {
  const out: GomokuMove[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (state.board[indexOf(r, c)] === "") out.push({ row: r, col: c });
    }
  }
  return out;
}

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], // horizontal
  [1, 0], // vertical
  [1, 1], // diag down-right
  [1, -1], // diag down-left
];

/**
 * Check whether the side that just moved at (lr, lc) created a run of
 * WIN_LEN or more. Returns the winning line if so, else null. We only
 * scan from the last move's cell — O(WIN_LEN × 4) — instead of the
 * whole board, since gomoku wins are local.
 */
function checkWinFromMove(board: Board, lr: number, lc: number, side: Side): ReadonlyArray<readonly [number, number]> | null {
  for (const [dr, dc] of DIRECTIONS) {
    let count = 1;
    const line: Array<[number, number]> = [[lr, lc]];
    // Walk forward from the move.
    let r = lr + dr;
    let c = lc + dc;
    while (inBounds(r, c) && board[indexOf(r, c)] === side) {
      line.push([r, c]);
      count++;
      r += dr;
      c += dc;
    }
    // Walk backward.
    r = lr - dr;
    c = lc - dc;
    while (inBounds(r, c) && board[indexOf(r, c)] === side) {
      line.unshift([r, c]);
      count++;
      r -= dr;
      c -= dc;
    }
    if (count >= WIN_LEN) return line;
  }
  return null;
}

/**
 * Full-board check for win — slower, used when we don't know which move
 * was last (e.g. checking a constructed test position).
 */
function checkWinFullBoard(board: Board): ReadonlyArray<readonly [number, number]> & { side: Side } | null {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = board[indexOf(r, c)];
      if (v === "") continue;
      const line = checkWinFromMove(board, r, c, v as Side);
      if (line) {
        // Annotate with side via a hidden property.
        const result = line as ReadonlyArray<readonly [number, number]> & { side: Side };
        // We construct a tagged return value so the caller knows the winner.
        (result as { side: Side }).side = v as Side;
        return result;
      }
    }
  }
  return null;
}

export function checkResult(state: GomokuState): GomokuResult {
  // Fast path: check from last move only.
  if (state.lastMove) {
    const { row, col, player } = state.lastMove;
    const line = checkWinFromMove(state.board, row, col, player);
    if (line) return { status: "win", winner: player, line };
  } else {
    // No last move recorded — fall back to full scan.
    const win = checkWinFullBoard(state.board);
    if (win) return { status: "win", winner: win.side, line: win };
  }
  // Draw if the board is full.
  for (const c of state.board) if (c === "") return { status: "ongoing" };
  return { status: "draw" };
}

export function applyMove(state: GomokuState, move: GomokuMove): GomokuState {
  if (!isLegalMove(state.board, move.row, move.col)) {
    throw new Error(`illegal move at (${move.row}, ${move.col})`);
  }
  const next = cloneState(state);
  next.board[indexOf(move.row, move.col)] = state.turn;
  next.lastMove = { row: move.row, col: move.col, player: state.turn };
  next.moveCount += 1;
  next.turn = opposite(state.turn);
  return next;
}

// ---------------------------------------------------------------------------
// ASCII renderer for tests
// ---------------------------------------------------------------------------

export function renderBoard(board: Board): string {
  const rows: string[] = [];
  for (let r = 0; r < SIZE; r++) {
    const cells: string[] = [];
    for (let c = 0; c < SIZE; c++) {
      const v = board[indexOf(r, c)];
      cells.push(v === "" ? "." : v);
    }
    rows.push(cells.join(" "));
  }
  return rows.join("\n");
}

// ---------------------------------------------------------------------------
// boardgame.io Game definition
// ---------------------------------------------------------------------------

export const game: Game<GomokuState> = {
  name: "gomoku",
  setup: () => startingState(),
  turn: { minMoves: 1, maxMoves: 1 },
  moves: {
    place: ({ G, playerID }, raw: unknown) => {
      const expectedSide: Side = playerID === "0" ? "B" : "W";
      if (G.turn !== expectedSide) return INVALID_MOVE;
      const arg = raw as { row?: unknown; col?: unknown };
      const row = Number(arg.row);
      const col = Number(arg.col);
      if (!Number.isInteger(row) || !Number.isInteger(col) || !inBounds(row, col)) {
        return INVALID_MOVE;
      }
      if (G.board[indexOf(row, col)] !== "") return INVALID_MOVE;

      G.board[indexOf(row, col)] = expectedSide;
      G.lastMove = { row, col, player: expectedSide };
      G.moveCount += 1;
      G.turn = opposite(expectedSide);
    },
  },
  endIf: ({ G }) => {
    const result = checkResult(G);
    if (result.status === "win") {
      return { winner: result.winner === "B" ? "0" : "1" };
    }
    if (result.status === "draw") return { draw: true };
  },
};
