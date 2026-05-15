/**
 * Tic-Tac-Toe — pure rules engine + boardgame.io game definition.
 *
 * 3×3 grid. Player 1 = "X", Player 2 = "O". First to align three in a row,
 * column, or diagonal wins. Filled board with no winner is a draw.
 *
 * The pure helpers (`applyMove`, `checkResult`, `legalMoves`) are exported so
 * the system bot's minimax doesn't pay the boardgame.io reducer cost on
 * every search node. The boardgame.io `Game` delegates to the same
 * primitives so behavior is identical.
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const SIZE = 3;
export const CELLS = SIZE * SIZE;

export type Cell = 0 | 1 | 2;
export type Board = Cell[];
export type Player = 1 | 2;

export interface TicTacToeState {
  board: Board;
  lastMove: { index: number; player: Player } | null;
}

export type GameResult =
  | { status: "ongoing" }
  | { status: "win"; winner: Player; line: readonly [number, number, number] }
  | { status: "draw" };

/** All 8 winning lines as cell-index triples. */
export const LINES: ReadonlyArray<readonly [number, number, number]> = [
  // rows
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  // cols
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  // diagonals
  [0, 4, 8],
  [2, 4, 6],
];

export function emptyBoard(): Board {
  return Array<Cell>(CELLS).fill(0);
}

export function cloneBoard(board: Board): Board {
  return board.slice() as Board;
}

export function isLegalMove(board: Board, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < CELLS && board[index] === 0;
}

export function legalMoves(board: Board): number[] {
  const out: number[] = [];
  for (let i = 0; i < CELLS; i++) if (board[i] === 0) out.push(i);
  return out;
}

export function applyMove(board: Board, index: number, player: Player): Board {
  if (!isLegalMove(board, index)) {
    throw new Error(`illegal move: cell ${index} occupied or out of range`);
  }
  const next = cloneBoard(board);
  next[index] = player;
  return next;
}

export function opponentOf(player: Player): Player {
  return player === 1 ? 2 : 1;
}

export function checkResult(board: Board): GameResult {
  for (const line of LINES) {
    const [a, b, c] = line;
    const v = board[a];
    if (v !== 0 && v === board[b] && v === board[c]) {
      return { status: "win", winner: v as Player, line };
    }
  }
  for (let i = 0; i < CELLS; i++) if (board[i] === 0) return { status: "ongoing" };
  return { status: "draw" };
}

/** Returns row,col from a flat index. Useful for renderers and tests. */
export function rowColOf(index: number): [number, number] {
  return [Math.floor(index / SIZE), index % SIZE];
}

/** Returns flat index from row,col. */
export function indexOf(row: number, col: number): number {
  return row * SIZE + col;
}

/** ASCII render for tests + debugging. */
export function renderBoard(board: Board): string {
  const lines: string[] = [];
  for (let r = 0; r < SIZE; r++) {
    const cells: string[] = [];
    for (let c = 0; c < SIZE; c++) {
      const v = board[indexOf(r, c)];
      cells.push(v === 0 ? "." : v === 1 ? "X" : "O");
    }
    lines.push(cells.join(" "));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// boardgame.io Game definition
// ---------------------------------------------------------------------------

export const game: Game<TicTacToeState> = {
  name: "tic-tac-toe",
  setup: () => ({ board: emptyBoard(), lastMove: null }),
  turn: { minMoves: 1, maxMoves: 1 },
  moves: {
    /**
     * `place` takes a flat cell index 0..8 (row-major, top-left = 0).
     * Returns INVALID_MOVE for out-of-range or occupied cells, which the
     * server flow translates to an invalid-move strike.
     */
    place: ({ G, playerID }, index: number) => {
      if (!isLegalMove(G.board, index)) return INVALID_MOVE;
      const player: Player = playerID === "0" ? 1 : 2;
      G.board[index] = player;
      G.lastMove = { index, player };
    },
  },
  endIf: ({ G }) => {
    const result = checkResult(G.board);
    if (result.status === "win") {
      return { winner: result.winner === 1 ? "0" : "1" };
    }
    if (result.status === "draw") return { draw: true };
  },
};
