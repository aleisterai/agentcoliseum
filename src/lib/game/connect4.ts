/**
 * Connect 4 — pure rules engine. No I/O, no side effects, fully unit-testable.
 *
 * Board representation:
 *   - 6 rows × 7 columns
 *   - row 0 = top, column 0 = left
 *   - cells: 0 = empty, 1 = player 1, 2 = player 2
 *   - "drop" semantics: a piece falls to the lowest empty row in the chosen column
 *
 * This file is shared between the API (validating moves), the frontend
 * (rendering pre-commit state), and the system-bot (search).
 */

export const ROWS = 6;
export const COLS = 7;

/** A board is a 6×7 grid of {0,1,2}. Player ids are 1 and 2. */
export type Board = number[][];
export type Player = 1 | 2;
export type Cell = 0 | 1 | 2;

export type GameResult =
  | { status: "ongoing" }
  | { status: "win"; winner: Player; line: ReadonlyArray<readonly [number, number]> }
  | { status: "draw" };

/** Brand-new empty 6×7 board. */
export function emptyBoard(): Board {
  return Array.from({ length: ROWS }, () => Array<number>(COLS).fill(0));
}

/** Deep clone (board is a small fixed-shape grid, so JSON is fine and safer). */
export function cloneBoard(board: Board): Board {
  return board.map((row) => row.slice());
}

/** Returns the row index a piece would land in for `col`, or -1 if full. */
export function landingRow(board: Board, col: number): number {
  if (col < 0 || col >= COLS) return -1;
  for (let r = ROWS - 1; r >= 0; r--) {
    if (board[r][col] === 0) return r;
  }
  return -1;
}

/** True iff the column has at least one empty cell and is in range. */
export function isLegalMove(board: Board, col: number): boolean {
  return landingRow(board, col) !== -1;
}

/** All currently-legal column indices, left to right. */
export function legalMoves(board: Board): number[] {
  const out: number[] = [];
  for (let c = 0; c < COLS; c++) if (isLegalMove(board, c)) out.push(c);
  return out;
}

/**
 * Apply `player`'s move in `col`. Returns a NEW board. Throws if illegal.
 * (Callers should pre-validate with isLegalMove for graceful flows.)
 */
export function applyMove(board: Board, col: number, player: Player): Board {
  const r = landingRow(board, col);
  if (r === -1) {
    throw new Error(`illegal move: column ${col} is full or out of range`);
  }
  const next = cloneBoard(board);
  next[r][col] = player;
  return next;
}

/**
 * Identify the winner (if any) and return the four-in-a-row cells.
 * Checks all four directions: horizontal, vertical, ↘ diagonal, ↗ diagonal.
 */
export function checkResult(board: Board): GameResult {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = board[r][c];
      if (v === 0) continue;
      // → horizontal
      if (c + 3 < COLS && board[r][c + 1] === v && board[r][c + 2] === v && board[r][c + 3] === v) {
        return {
          status: "win",
          winner: v as Player,
          line: [
            [r, c],
            [r, c + 1],
            [r, c + 2],
            [r, c + 3],
          ],
        };
      }
      // ↓ vertical
      if (r + 3 < ROWS && board[r + 1][c] === v && board[r + 2][c] === v && board[r + 3][c] === v) {
        return {
          status: "win",
          winner: v as Player,
          line: [
            [r, c],
            [r + 1, c],
            [r + 2, c],
            [r + 3, c],
          ],
        };
      }
      // ↘ down-right
      if (
        r + 3 < ROWS &&
        c + 3 < COLS &&
        board[r + 1][c + 1] === v &&
        board[r + 2][c + 2] === v &&
        board[r + 3][c + 3] === v
      ) {
        return {
          status: "win",
          winner: v as Player,
          line: [
            [r, c],
            [r + 1, c + 1],
            [r + 2, c + 2],
            [r + 3, c + 3],
          ],
        };
      }
      // ↗ up-right
      if (
        r - 3 >= 0 &&
        c + 3 < COLS &&
        board[r - 1][c + 1] === v &&
        board[r - 2][c + 2] === v &&
        board[r - 3][c + 3] === v
      ) {
        return {
          status: "win",
          winner: v as Player,
          line: [
            [r, c],
            [r - 1, c + 1],
            [r - 2, c + 2],
            [r - 3, c + 3],
          ],
        };
      }
    }
  }
  // No winner. Draw iff the board is full.
  for (let c = 0; c < COLS; c++) {
    if (board[0][c] === 0) return { status: "ongoing" };
  }
  return { status: "draw" };
}

/** Convenience: the opponent's player id. */
export function opponentOf(player: Player): Player {
  return player === 1 ? 2 : 1;
}

/** Pretty-print a board for logs / debugging. */
export function renderBoard(board: Board): string {
  return board
    .map((row) => row.map((v) => (v === 0 ? "." : v === 1 ? "X" : "O")).join(" "))
    .join("\n");
}
