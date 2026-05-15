/**
 * Connect 4 — pure rules engine + boardgame.io game definition.
 *
 * The pure helpers (Board, applyMove, checkResult, legalMoves) stay exported
 * because the system-bot's negamax search is the hot path; routing every
 * lookahead node through boardgame.io's reducer would be wasteful. The
 * boardgame.io `Game` is the source of truth for state transitions applied
 * via the engine wrapper, and it delegates to the same primitives.
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const ROWS = 6;
export const COLS = 7;

export type Board = number[][];
export type Player = 1 | 2;
export type Cell = 0 | 1 | 2;

export interface Connect4State {
  board: Board;
  lastMove: { row: number; col: number; player: Player } | null;
}

export type GameResult =
  | { status: "ongoing" }
  | { status: "win"; winner: Player; line: ReadonlyArray<readonly [number, number]> }
  | { status: "draw" };

export function emptyBoard(): Board {
  return Array.from({ length: ROWS }, () => Array<number>(COLS).fill(0));
}

export function cloneBoard(board: Board): Board {
  return board.map((row) => row.slice());
}

export function landingRow(board: Board, col: number): number {
  if (col < 0 || col >= COLS) return -1;
  for (let r = ROWS - 1; r >= 0; r--) {
    if (board[r][col] === 0) return r;
  }
  return -1;
}

export function isLegalMove(board: Board, col: number): boolean {
  return landingRow(board, col) !== -1;
}

export function legalMoves(board: Board): number[] {
  const out: number[] = [];
  for (let c = 0; c < COLS; c++) if (isLegalMove(board, c)) out.push(c);
  return out;
}

export function applyMove(board: Board, col: number, player: Player): Board {
  const r = landingRow(board, col);
  if (r === -1) throw new Error(`illegal move: column ${col} is full or out of range`);
  const next = cloneBoard(board);
  next[r][col] = player;
  return next;
}

export function opponentOf(player: Player): Player {
  return player === 1 ? 2 : 1;
}

export function checkResult(board: Board): GameResult {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = board[r][c];
      if (v === 0) continue;
      if (c + 3 < COLS && board[r][c + 1] === v && board[r][c + 2] === v && board[r][c + 3] === v) {
        return { status: "win", winner: v as Player, line: [[r, c], [r, c + 1], [r, c + 2], [r, c + 3]] };
      }
      if (r + 3 < ROWS && board[r + 1][c] === v && board[r + 2][c] === v && board[r + 3][c] === v) {
        return { status: "win", winner: v as Player, line: [[r, c], [r + 1, c], [r + 2, c], [r + 3, c]] };
      }
      if (
        r + 3 < ROWS && c + 3 < COLS &&
        board[r + 1][c + 1] === v && board[r + 2][c + 2] === v && board[r + 3][c + 3] === v
      ) {
        return {
          status: "win",
          winner: v as Player,
          line: [[r, c], [r + 1, c + 1], [r + 2, c + 2], [r + 3, c + 3]],
        };
      }
      if (
        r - 3 >= 0 && c + 3 < COLS &&
        board[r - 1][c + 1] === v && board[r - 2][c + 2] === v && board[r - 3][c + 3] === v
      ) {
        return {
          status: "win",
          winner: v as Player,
          line: [[r, c], [r - 1, c + 1], [r - 2, c + 2], [r - 3, c + 3]],
        };
      }
    }
  }
  for (let c = 0; c < COLS; c++) if (board[0][c] === 0) return { status: "ongoing" };
  return { status: "draw" };
}

export function renderBoard(board: Board): string {
  return board.map((row) => row.map((v) => (v === 0 ? "." : v === 1 ? "X" : "O")).join(" ")).join("\n");
}

// ---------------------------------------------------------------------------
// boardgame.io Game definition
// ---------------------------------------------------------------------------

export const game: Game<Connect4State> = {
  name: "connect4",
  setup: () => ({ board: emptyBoard(), lastMove: null }),
  turn: { minMoves: 1, maxMoves: 1 },
  moves: {
    drop: ({ G, playerID }, column: number) => {
      if (typeof column !== "number" || !Number.isInteger(column) || column < 0 || column >= COLS) {
        return INVALID_MOVE;
      }
      if (G.board[0][column] !== 0) return INVALID_MOVE;
      const player: Player = playerID === "0" ? 1 : 2;
      for (let r = ROWS - 1; r >= 0; r--) {
        if (G.board[r][column] === 0) {
          G.board[r][column] = player;
          G.lastMove = { row: r, col: column, player };
          return;
        }
      }
      return INVALID_MOVE;
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
