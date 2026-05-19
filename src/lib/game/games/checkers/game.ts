/**
 * Checkers (English draughts) — pure rules engine + boardgame.io game def.
 *
 * 8×8 board, pieces only on dark squares. Each side starts with 12 men on
 * their three back ranks. Men move diagonally forward one square; kings
 * (men that reach the opposite back rank) move diagonally any direction.
 *
 * Mandatory capture: if any of your pieces can capture, you MUST capture.
 * If a capture lands on a square from which another capture is possible
 * for the same piece, you MUST continue jumping (multi-jump). When jumps
 * exist, only jump-moves are legal.
 *
 * A move payload is the trailing sequence of squares the piece visits:
 *   { from: [row, col], path: [[r1, c1], [r2, c2], ...] }
 * For a simple slide, path has length 1 (the destination). For a jump
 * sequence, path is the chain of landing squares in order.
 *
 * Win/draw:
 *   - You win if the opponent has no legal moves (no piece + no slide + no
 *     jump). That includes "no pieces remaining."
 *   - 40-move rule: 40 plies with no capture or man-move = draw (chosen
 *     for tractability; FIDE-equivalent for draughts).
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const SIZE = 8;

export type Side = "B" | "W";
export type PieceLetter = "m" | "k"; // m = man, k = king
export type Piece = `${Side}${PieceLetter}`;
export type Cell = Piece | "";
export type Board = Cell[]; // length 64, row-major

export interface CheckersMove {
  from: [number, number];
  /** Chain of landing squares. Length 1 = slide, >=1 = jump chain. */
  path: Array<[number, number]>;
}

export interface CheckersState {
  board: Board;
  turn: Side;
  /** Plies since the last capture or man-move (40 = draw). */
  halfmoveClock: number;
  lastMove: CheckersMove | null;
}

export type CheckersResult =
  | { status: "ongoing" }
  | { status: "win"; winner: Side; reason: "no_moves" | "no_pieces" }
  | { status: "draw"; reason: "fortymove" };

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

/** Dark squares are where (row + col) % 2 === 1. Only these hold pieces. */
export function isDarkSquare(row: number, col: number): boolean {
  return ((row + col) & 1) === 1;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function emptyBoard(): Board {
  return Array<Cell>(64).fill("");
}

export function startingBoard(): Board {
  const b = emptyBoard();
  // Black pieces in rows 0-2 (top three rows from White's POV).
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (isDarkSquare(r, c)) b[indexOf(r, c)] = "Bm";
    }
  }
  // White pieces in rows 5-7 (bottom three rows).
  for (let r = 5; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (isDarkSquare(r, c)) b[indexOf(r, c)] = "Wm";
    }
  }
  return b;
}

export function startingState(): CheckersState {
  return {
    board: startingBoard(),
    turn: "W",
    halfmoveClock: 0,
    lastMove: null,
  };
}

export function cloneState(s: CheckersState): CheckersState {
  return {
    board: s.board.slice() as Board,
    turn: s.turn,
    halfmoveClock: s.halfmoveClock,
    lastMove: s.lastMove ? { from: [...s.lastMove.from], path: s.lastMove.path.map((p) => [...p] as [number, number]) } : null,
  };
}

export function opposite(side: Side): Side {
  return side === "W" ? "B" : "W";
}

export function sideOf(p: Cell): Side | null {
  return p === "" ? null : (p[0] as Side);
}

export function isKing(p: Cell): boolean {
  return p !== "" && p[1] === "k";
}

// ---------------------------------------------------------------------------
// Move generation
// ---------------------------------------------------------------------------

/** Returns diagonal direction deltas a piece can travel. */
function dirsFor(piece: Piece): Array<[number, number]> {
  if (isKing(piece)) return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  // Men move toward the opponent's back rank only.
  return piece[0] === "W"
    ? [[-1, -1], [-1, 1]] // White moves up (decreasing row)
    : [[1, -1], [1, 1]]; // Black moves down
}

/**
 * Enumerate all complete jump chains starting from `(fromRow, fromCol)`.
 * A jump chain is a sequence of consecutive captures by the same piece.
 * Returns the list of full chains (each a list of landing squares in order).
 *
 * Operates on a working board copy where captured pieces are temporarily
 * cleared so the same piece isn't captured twice in one chain.
 */
function jumpChainsFrom(
  board: Board,
  piece: Piece,
  fromRow: number,
  fromCol: number,
): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  const visited = new Set<string>();
  // Walk uses an undo/redo mutation pattern on a single working board. If
  // `board` came in frozen (e.g. boardgame.io's Immer-wrapped state), the
  // first `workingBoard[i] = ""` throws. Slice once up front so all mutations
  // happen on a fresh, writable copy.
  const workingBoard = board.slice() as Board;
  // Track promotion mid-chain — a man that becomes a king during a chain
  // immediately gains king mobility for subsequent jumps (per English rules).
  walk(piece, fromRow, fromCol, [], workingBoard);
  return out;

  function walk(
    cur: Piece,
    r: number,
    c: number,
    chain: Array<[number, number]>,
    workingBoard: Board,
  ) {
    let extended = false;
    const dirs = dirsFor(cur);
    for (const [dr, dc] of dirs) {
      const midR = r + dr;
      const midC = c + dc;
      const landR = r + 2 * dr;
      const landC = c + 2 * dc;
      if (!inBounds(midR, midC) || !inBounds(landR, landC)) continue;
      const midPiece = workingBoard[indexOf(midR, midC)];
      const landPiece = workingBoard[indexOf(landR, landC)];
      if (midPiece === "" || sideOf(midPiece) === cur[0] || landPiece !== "") continue;

      const key = `${midR},${midC}`;
      if (visited.has(key)) continue;

      // Apply the jump on the working board.
      visited.add(key);
      const prevMid = workingBoard[indexOf(midR, midC)];
      const prevLand = workingBoard[indexOf(landR, landC)];
      const prevFrom = workingBoard[indexOf(r, c)];
      workingBoard[indexOf(midR, midC)] = "";
      workingBoard[indexOf(landR, landC)] = cur;
      workingBoard[indexOf(r, c)] = "";

      // Promotion mid-chain
      let nextPiece: Piece = cur;
      if (!isKing(cur)) {
        if (cur[0] === "W" && landR === 0) nextPiece = "Wk";
        else if (cur[0] === "B" && landR === 7) nextPiece = "Bk";
      }
      if (nextPiece !== cur) workingBoard[indexOf(landR, landC)] = nextPiece;

      walk(nextPiece, landR, landC, [...chain, [landR, landC]], workingBoard);
      extended = true;

      // Undo
      workingBoard[indexOf(midR, midC)] = prevMid;
      workingBoard[indexOf(landR, landC)] = prevLand;
      workingBoard[indexOf(r, c)] = prevFrom;
      visited.delete(key);
    }
    if (!extended && chain.length > 0) {
      out.push(chain);
    }
  }
}

/**
 * All legal moves for the side to move. Captures are mandatory: if ANY
 * piece can capture, only capture chains are returned.
 */
export function legalMoves(state: CheckersState): CheckersMove[] {
  const out: CheckersMove[] = [];
  let captures: CheckersMove[] = [];
  for (let i = 0; i < 64; i++) {
    const piece = state.board[i];
    if (piece === "" || sideOf(piece) !== state.turn) continue;
    const [r, c] = rowColOf(i);
    const chains = jumpChainsFrom(state.board, piece, r, c);
    if (chains.length > 0) {
      for (const chain of chains) captures.push({ from: [r, c], path: chain });
    }
    if (captures.length === 0) {
      // Slides allowed only if no captures exist for any piece. We still
      // collect them in `out` but discard if captures are found.
      for (const [dr, dc] of dirsFor(piece)) {
        const nr = r + dr;
        const nc = c + dc;
        if (!inBounds(nr, nc)) continue;
        if (state.board[indexOf(nr, nc)] === "") {
          out.push({ from: [r, c], path: [[nr, nc]] });
        }
      }
    }
  }
  return captures.length > 0 ? captures : out;
}

/**
 * Apply a move (assumed legal) and return a fresh state. Handles capture
 * removal, promotion (end-of-move or mid-chain), turn flip, halfmove clock.
 */
export function applyMove(state: CheckersState, move: CheckersMove): CheckersState {
  const next = cloneState(state);
  const [fr, fc] = move.from;
  let piece = next.board[indexOf(fr, fc)];
  if (piece === "") throw new Error(`applyMove: no piece at ${fr},${fc}`);
  const side = sideOf(piece) as Side;

  next.board[indexOf(fr, fc)] = "";

  let curR = fr;
  let curC = fc;
  let captured = false;
  for (const [nr, nc] of move.path) {
    // Detect whether this step is a jump (distance 2 diagonally) or slide.
    const dr = nr - curR;
    const dc = nc - curC;
    if (Math.abs(dr) === 2 && Math.abs(dc) === 2) {
      const midR = curR + dr / 2;
      const midC = curC + dc / 2;
      next.board[indexOf(midR, midC)] = "";
      captured = true;
    }
    // Promotion mid-chain for men.
    if (piece === "Wm" && nr === 0) piece = "Wk";
    else if (piece === "Bm" && nr === 7) piece = "Bk";
    curR = nr;
    curC = nc;
  }
  next.board[indexOf(curR, curC)] = piece;

  // Halfmove clock: resets on capture or man move; increments on king slide.
  if (captured || piece[1] === "m") {
    next.halfmoveClock = 0;
  } else {
    next.halfmoveClock += 1;
  }

  next.turn = opposite(side);
  next.lastMove = { from: [...move.from] as [number, number], path: move.path.map((p) => [...p] as [number, number]) };
  return next;
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

function countPieces(board: Board, side: Side): number {
  let n = 0;
  for (const c of board) if (c !== "" && c[0] === side) n++;
  return n;
}

export function checkResult(state: CheckersState): CheckersResult {
  if (state.halfmoveClock >= 40) return { status: "draw", reason: "fortymove" };
  // Side to move has no pieces → other side wins (no_pieces).
  if (countPieces(state.board, state.turn) === 0) {
    return { status: "win", winner: opposite(state.turn), reason: "no_pieces" };
  }
  if (legalMoves(state).length === 0) {
    return { status: "win", winner: opposite(state.turn), reason: "no_moves" };
  }
  return { status: "ongoing" };
}

// ---------------------------------------------------------------------------
// ASCII render for tests
// ---------------------------------------------------------------------------

const GLYPHS: Record<Cell, string> = {
  "": ".",
  Wm: "w", Wk: "W",
  Bm: "b", Bk: "B",
};

export function renderBoard(board: Board): string {
  const rows: string[] = [];
  for (let r = 0; r < SIZE; r++) {
    const row: string[] = [];
    for (let c = 0; c < SIZE; c++) row.push(GLYPHS[board[indexOf(r, c)]]);
    rows.push(row.join(" "));
  }
  return rows.join("\n");
}

// ---------------------------------------------------------------------------
// boardgame.io Game definition
// ---------------------------------------------------------------------------

export const game: Game<CheckersState> = {
  name: "checkers",
  setup: () => startingState(),
  turn: { minMoves: 1, maxMoves: 1 },
  moves: {
    play: ({ G, playerID }, raw: unknown) => {
      const expectedSide: Side = playerID === "0" ? "W" : "B";
      if (G.turn !== expectedSide) return INVALID_MOVE;

      const arg = raw as { from?: unknown; path?: unknown };
      if (!Array.isArray(arg.from) || arg.from.length !== 2) return INVALID_MOVE;
      if (!Array.isArray(arg.path) || arg.path.length === 0) return INVALID_MOVE;
      const from: [number, number] = [Number(arg.from[0]), Number(arg.from[1])];
      const path: Array<[number, number]> = [];
      for (const step of arg.path as unknown[]) {
        if (!Array.isArray(step) || step.length !== 2) return INVALID_MOVE;
        path.push([Number(step[0]), Number(step[1])]);
      }
      if (
        !inBounds(from[0], from[1]) ||
        path.some(([r, c]) => !inBounds(r, c) || !Number.isInteger(r) || !Number.isInteger(c))
      ) {
        return INVALID_MOVE;
      }

      // Match against legal moves — never trust the client.
      const legal = legalMoves(G);
      const match = legal.find(
        (m) =>
          m.from[0] === from[0] &&
          m.from[1] === from[1] &&
          m.path.length === path.length &&
          m.path.every((p, i) => p[0] === path[i][0] && p[1] === path[i][1]),
      );
      if (!match) return INVALID_MOVE;

      const next = applyMove(G, match);
      G.board = next.board;
      G.turn = next.turn;
      G.halfmoveClock = next.halfmoveClock;
      G.lastMove = next.lastMove;
    },
  },
  endIf: ({ G }) => {
    const result = checkResult(G);
    if (result.status === "win") {
      return { winner: result.winner === "W" ? "0" : "1" };
    }
    if (result.status === "draw") return { draw: true };
  },
};
