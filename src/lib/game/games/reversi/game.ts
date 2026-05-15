/**
 * Reversi (Othello) — pure rules engine + boardgame.io game definition.
 *
 * 8×8 board. Players are Black (B) and White (W). The four center squares
 * start with a fixed Black-White diagonal: D5/E4 = B, E5/D4 = W (or in
 * row-major terms: (3,3)=W, (3,4)=B, (4,3)=B, (4,4)=W).
 *
 * On your turn you place a disc on an empty square IF doing so flanks at
 * least one of the opponent's discs (i.e. an unbroken straight line of
 * opponent discs between your new disc and another of your discs already
 * on the board). All flanked discs flip to your color. There must be
 * progress on every move — passes only happen automatically if you have
 * NO legal moves, in which case the turn skips to the opponent. If
 * neither side has a legal move, the game ends and the side with more
 * discs wins (or a tie).
 *
 * Move payload: `{ row: number, col: number }` (0-7 each).
 *
 * Board representation: flat Cell[64], row-major. Cell values:
 *   "" empty, "B" black, "W" white.
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const SIZE = 8;

export type Side = "B" | "W";
export type Cell = Side | "";
export type Board = Cell[]; // length 64

export interface ReversiMove {
  row: number;
  col: number;
}

export interface ReversiState {
  board: Board;
  turn: Side;
  /** Last move played, including the squares that flipped (for the renderer). */
  lastMove: { row: number; col: number; flipped: Array<[number, number]> } | null;
  /** Plies that ended in an auto-pass (no legal move). Two consecutive passes = game end. */
  consecutivePasses: number;
}

export type ReversiResult =
  | { status: "ongoing" }
  | { status: "win"; winner: Side; bScore: number; wScore: number }
  | { status: "draw"; bScore: number; wScore: number };

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

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function emptyBoard(): Board {
  return Array<Cell>(64).fill("");
}

export function startingBoard(): Board {
  const b = emptyBoard();
  b[indexOf(3, 3)] = "W";
  b[indexOf(3, 4)] = "B";
  b[indexOf(4, 3)] = "B";
  b[indexOf(4, 4)] = "W";
  return b;
}

export function startingState(): ReversiState {
  return {
    board: startingBoard(),
    turn: "B", // Black moves first in Reversi.
    lastMove: null,
    consecutivePasses: 0,
  };
}

export function cloneState(s: ReversiState): ReversiState {
  return {
    board: s.board.slice() as Board,
    turn: s.turn,
    lastMove: s.lastMove
      ? {
          row: s.lastMove.row,
          col: s.lastMove.col,
          flipped: s.lastMove.flipped.map((p) => [...p] as [number, number]),
        }
      : null,
    consecutivePasses: s.consecutivePasses,
  };
}

export function opposite(side: Side): Side {
  return side === "B" ? "W" : "B";
}

// ---------------------------------------------------------------------------
// Move generation
// ---------------------------------------------------------------------------

/**
 * For a placement at (row, col), returns every direction's flippable run.
 * The returned array has one entry per direction with at least one captured
 * disc; each entry is the list of [r, c] cells that would flip. If empty,
 * the move is illegal.
 */
export function captureRuns(board: Board, row: number, col: number, side: Side): Array<[number, number]> {
  if (!inBounds(row, col) || board[indexOf(row, col)] !== "") return [];
  const opp = opposite(side);
  const flips: Array<[number, number]> = [];
  for (const [dr, dc] of DIRS) {
    let r = row + dr;
    let c = col + dc;
    const candidate: Array<[number, number]> = [];
    while (inBounds(r, c) && board[indexOf(r, c)] === opp) {
      candidate.push([r, c]);
      r += dr;
      c += dc;
    }
    // Must end on our own disc; an immediate own-disc or off-board / empty
    // means no flip in this direction.
    if (candidate.length > 0 && inBounds(r, c) && board[indexOf(r, c)] === side) {
      flips.push(...candidate);
    }
  }
  return flips;
}

export function isLegalMove(board: Board, row: number, col: number, side: Side): boolean {
  if (!inBounds(row, col) || board[indexOf(row, col)] !== "") return false;
  return captureRuns(board, row, col, side).length > 0;
}

export function legalMoves(state: ReversiState): ReversiMove[] {
  const out: ReversiMove[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (isLegalMove(state.board, r, c, state.turn)) {
        out.push({ row: r, col: c });
      }
    }
  }
  return out;
}

/**
 * Apply a move. The move is assumed legal — call legalMoves() to enumerate
 * first. Returns a fresh state.
 *
 * After the move we flip turn. If the new side-to-move has no legal moves,
 * we auto-pass (flip turn again) and increment consecutivePasses. Two
 * consecutive auto-passes end the game.
 */
export function applyMove(state: ReversiState, move: ReversiMove): ReversiState {
  const next = cloneState(state);
  const { row, col } = move;
  const side = state.turn;
  const flips = captureRuns(state.board, row, col, side);
  if (flips.length === 0) {
    throw new Error(`applyMove: illegal placement at (${row}, ${col})`);
  }
  next.board[indexOf(row, col)] = side;
  for (const [r, c] of flips) next.board[indexOf(r, c)] = side;

  next.lastMove = { row, col, flipped: flips };
  next.consecutivePasses = 0;
  next.turn = opposite(side);

  // Auto-pass when the new side has no legal moves.
  if (legalMoves(next).length === 0) {
    next.consecutivePasses += 1;
    next.turn = opposite(next.turn);
    // If the original side ALSO has no legal moves now, leave
    // consecutivePasses at 1 and let checkResult finalize on next call.
    // (We don't bump to 2 here — that requires the opposite side to also
    // pass on its turn, which it can't because we just flipped back.)
  }
  return next;
}

// ---------------------------------------------------------------------------
// Scoring + termination
// ---------------------------------------------------------------------------

export function scoreOf(board: Board): { B: number; W: number } {
  let B = 0;
  let W = 0;
  for (const c of board) {
    if (c === "B") B++;
    else if (c === "W") W++;
  }
  return { B, W };
}

export function checkResult(state: ReversiState): ReversiResult {
  // Game ends when neither side can move. With our auto-pass logic, this
  // happens when consecutivePasses === 1 AND the current side also has no
  // legal moves (i.e. both sides passed).
  const sideToMoveCanMove = legalMoves(state).length > 0;
  const boardFull = !state.board.includes("");
  const stalemate = !sideToMoveCanMove && state.consecutivePasses >= 1;
  if (boardFull || stalemate) {
    const { B, W } = scoreOf(state.board);
    if (B > W) return { status: "win", winner: "B", bScore: B, wScore: W };
    if (W > B) return { status: "win", winner: "W", bScore: B, wScore: W };
    return { status: "draw", bScore: B, wScore: W };
  }
  return { status: "ongoing" };
}

// ---------------------------------------------------------------------------
// ASCII render for tests
// ---------------------------------------------------------------------------

export function renderBoard(board: Board): string {
  const rows: string[] = [];
  for (let r = 0; r < SIZE; r++) {
    const row: string[] = [];
    for (let c = 0; c < SIZE; c++) {
      const v = board[indexOf(r, c)];
      row.push(v === "" ? "." : v);
    }
    rows.push(row.join(" "));
  }
  return rows.join("\n");
}

// ---------------------------------------------------------------------------
// boardgame.io Game definition
// ---------------------------------------------------------------------------

export const game: Game<ReversiState> = {
  name: "reversi",
  setup: () => startingState(),
  turn: { minMoves: 1, maxMoves: 1 },
  moves: {
    place: ({ G, playerID }, raw: unknown) => {
      // playerID "0" = Black (first to move), "1" = White.
      const expectedSide: Side = playerID === "0" ? "B" : "W";
      if (G.turn !== expectedSide) return INVALID_MOVE;
      const arg = raw as { row?: unknown; col?: unknown };
      const row = Number(arg.row);
      const col = Number(arg.col);
      if (!Number.isInteger(row) || !Number.isInteger(col) || !inBounds(row, col)) {
        return INVALID_MOVE;
      }
      if (!isLegalMove(G.board, row, col, expectedSide)) return INVALID_MOVE;

      const next = applyMove(G, { row, col });
      G.board = next.board;
      G.turn = next.turn;
      G.lastMove = next.lastMove;
      G.consecutivePasses = next.consecutivePasses;
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
