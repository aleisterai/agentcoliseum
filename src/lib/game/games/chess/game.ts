/**
 * Chess — full FIDE rules engine + boardgame.io game definition.
 *
 * Board representation: a flat `Cell[64]` array, row-major, index 0 = a8
 * (top-left from White's perspective), index 63 = h1 (bottom-right). Each
 * cell is "" (empty) or a two-char piece code: side letter (W/B) + piece
 * letter (P=pawn, N=knight, B=bishop, R=rook, Q=queen, K=king).
 *
 * State carries everything FIDE needs:
 *   - board (positions)
 *   - turn ("W" or "B")
 *   - castling rights (wK, wQ, bK, bQ)
 *   - enPassantTarget (the square BEHIND a pawn that just moved two squares,
 *     where the en-passant capture would land — or null)
 *   - halfmoveClock (resets on capture or pawn move; 50-move rule fires at 100)
 *   - fullmoveNumber (increments after Black moves)
 *   - positionHistory (string hashes for threefold repetition — see hashState)
 *   - lastMove (from / to + optional promotion piece)
 *
 * Move payload from agents:
 *   { from: "e2", to: "e4", promotion?: "Q"|"R"|"B"|"N" }
 *
 * The pure helpers (legalMoves, applyMove, checkResult) are exported so the
 * bot's negamax doesn't pay the boardgame.io reducer cost on every search
 * node. boardgame.io's Game delegates to the same primitives.
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export type Side = "W" | "B";
export type PieceLetter = "P" | "N" | "B" | "R" | "Q" | "K";
export type Piece = `${Side}${PieceLetter}`;
export type Cell = Piece | "";
export type Board = Cell[]; // length 64

export interface CastlingRights {
  wK: boolean;
  wQ: boolean;
  bK: boolean;
  bQ: boolean;
}

export interface Move {
  from: number;
  to: number;
  /** Set when the move is a pawn promotion. */
  promotion?: Exclude<PieceLetter, "P" | "K">;
}

export interface ChessState {
  board: Board;
  turn: Side;
  castling: CastlingRights;
  enPassantTarget: number | null;
  halfmoveClock: number;
  fullmoveNumber: number;
  positionHistory: string[];
  lastMove: Move | null;
}

export type ChessResult =
  | { status: "ongoing" }
  | { status: "win"; winner: Side; reason: "checkmate" | "resignation" }
  | {
      status: "draw";
      reason: "stalemate" | "fifty_move" | "threefold" | "insufficient_material";
    };

// ---------------------------------------------------------------------------
// Square name <-> index helpers
// ---------------------------------------------------------------------------

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

export function squareName(index: number): string {
  if (index < 0 || index > 63) throw new Error(`square index out of range: ${index}`);
  const file = FILES[index % 8];
  const rank = 8 - Math.floor(index / 8);
  return `${file}${rank}`;
}

export function squareIndex(name: string): number {
  if (typeof name !== "string" || name.length !== 2) {
    throw new Error(`invalid square name: ${String(name)}`);
  }
  const fileChar = name[0].toLowerCase();
  const rankChar = name[1];
  const file = FILES.indexOf(fileChar as (typeof FILES)[number]);
  const rank = Number.parseInt(rankChar, 10);
  if (file < 0 || !Number.isFinite(rank) || rank < 1 || rank > 8) {
    throw new Error(`invalid square name: ${name}`);
  }
  return (8 - rank) * 8 + file;
}

export function rowColOf(index: number): [number, number] {
  return [Math.floor(index / 8), index % 8];
}

export function indexOf(row: number, col: number): number {
  return row * 8 + col;
}

function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < 8 && col >= 0 && col < 8;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function emptyBoard(): Board {
  return Array<Cell>(64).fill("");
}

export function startingBoard(): Board {
  const b = emptyBoard();
  // Black back rank (rank 8, indices 0..7)
  b[0] = "BR"; b[1] = "BN"; b[2] = "BB"; b[3] = "BQ";
  b[4] = "BK"; b[5] = "BB"; b[6] = "BN"; b[7] = "BR";
  // Black pawns (rank 7, indices 8..15)
  for (let c = 0; c < 8; c++) b[8 + c] = "BP";
  // White pawns (rank 2, indices 48..55)
  for (let c = 0; c < 8; c++) b[48 + c] = "WP";
  // White back rank (rank 1, indices 56..63)
  b[56] = "WR"; b[57] = "WN"; b[58] = "WB"; b[59] = "WQ";
  b[60] = "WK"; b[61] = "WB"; b[62] = "WN"; b[63] = "WR";
  return b;
}

export function startingState(): ChessState {
  const board = startingBoard();
  return {
    board,
    turn: "W",
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    enPassantTarget: null,
    halfmoveClock: 0,
    fullmoveNumber: 1,
    positionHistory: [hashState(board, "W", { wK: true, wQ: true, bK: true, bQ: true }, null)],
    lastMove: null,
  };
}

export function cloneState(s: ChessState): ChessState {
  return {
    board: s.board.slice() as Board,
    turn: s.turn,
    castling: { ...s.castling },
    enPassantTarget: s.enPassantTarget,
    halfmoveClock: s.halfmoveClock,
    fullmoveNumber: s.fullmoveNumber,
    positionHistory: s.positionHistory.slice(),
    lastMove: s.lastMove ? { ...s.lastMove } : null,
  };
}

// ---------------------------------------------------------------------------
// Piece helpers
// ---------------------------------------------------------------------------

export function sideOf(piece: Cell): Side | null {
  if (piece === "") return null;
  return piece[0] as Side;
}

export function letterOf(piece: Cell): PieceLetter | null {
  if (piece === "") return null;
  return piece[1] as PieceLetter;
}

export function opposite(side: Side): Side {
  return side === "W" ? "B" : "W";
}

// ---------------------------------------------------------------------------
// Pseudolegal move generation per piece type
// ---------------------------------------------------------------------------

/**
 * Generate moves the piece could make ignoring whether it leaves own king
 * in check. The legal-move filter applies the check test on top.
 */
function pseudoMoves(s: ChessState, fromIdx: number): Move[] {
  const piece = s.board[fromIdx];
  if (piece === "") return [];
  const side = piece[0] as Side;
  const kind = piece[1] as PieceLetter;
  const [r, c] = rowColOf(fromIdx);
  const moves: Move[] = [];

  const push = (toR: number, toC: number, opts: { mustCapture?: boolean; noCapture?: boolean } = {}) => {
    if (!inBounds(toR, toC)) return false;
    const toIdx = indexOf(toR, toC);
    const target = s.board[toIdx];
    if (target !== "") {
      if (sideOf(target) === side) return false; // own piece blocks
      if (opts.noCapture) return false; // pawn straight push can't capture
      moves.push({ from: fromIdx, to: toIdx });
      return false; // capture; can't slide past
    }
    if (opts.mustCapture) return false; // pawn diagonal needs an enemy
    moves.push({ from: fromIdx, to: toIdx });
    return true; // empty; sliders continue
  };

  const slide = (dRow: number, dCol: number) => {
    let nr = r + dRow;
    let nc = c + dCol;
    while (push(nr, nc)) {
      nr += dRow;
      nc += dCol;
    }
  };

  if (kind === "P") {
    const dir = side === "W" ? -1 : 1;
    const startRank = side === "W" ? 6 : 1;
    const promotionRank = side === "W" ? 0 : 7;

    // One-square push (must be empty)
    if (inBounds(r + dir, c) && s.board[indexOf(r + dir, c)] === "") {
      addPawnMove(moves, fromIdx, indexOf(r + dir, c), r + dir === promotionRank);
      // Two-square push from starting rank
      if (r === startRank && s.board[indexOf(r + 2 * dir, c)] === "") {
        moves.push({ from: fromIdx, to: indexOf(r + 2 * dir, c) });
      }
    }
    // Diagonal captures
    for (const dc of [-1, 1] as const) {
      if (!inBounds(r + dir, c + dc)) continue;
      const toIdx = indexOf(r + dir, c + dc);
      const target = s.board[toIdx];
      if (target !== "" && sideOf(target) !== side) {
        addPawnMove(moves, fromIdx, toIdx, r + dir === promotionRank);
      } else if (s.enPassantTarget === toIdx) {
        // En passant: the diagonal target square is empty, but the
        // enPassantTarget exactly matches. The pawn captured sits on the
        // same rank as `from`. Legality re: check applied later.
        moves.push({ from: fromIdx, to: toIdx });
      }
    }
  } else if (kind === "N") {
    const knightDeltas = [
      [-2, -1], [-2, 1], [-1, -2], [-1, 2],
      [1, -2], [1, 2], [2, -1], [2, 1],
    ];
    for (const [dr, dc] of knightDeltas) {
      const nr = r + dr;
      const nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const target = s.board[indexOf(nr, nc)];
      if (target === "" || sideOf(target) !== side) {
        moves.push({ from: fromIdx, to: indexOf(nr, nc) });
      }
    }
  } else if (kind === "B") {
    slide(-1, -1); slide(-1, 1); slide(1, -1); slide(1, 1);
  } else if (kind === "R") {
    slide(-1, 0); slide(1, 0); slide(0, -1); slide(0, 1);
  } else if (kind === "Q") {
    slide(-1, -1); slide(-1, 1); slide(1, -1); slide(1, 1);
    slide(-1, 0); slide(1, 0); slide(0, -1); slide(0, 1);
  } else if (kind === "K") {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (!inBounds(nr, nc)) continue;
        const target = s.board[indexOf(nr, nc)];
        if (target === "" || sideOf(target) !== side) {
          moves.push({ from: fromIdx, to: indexOf(nr, nc) });
        }
      }
    }
    // Castling — pseudolegal only checks emptiness + rights here. The
    // legal filter additionally ensures the king isn't in check, doesn't
    // pass through check, and doesn't land in check.
    if (side === "W" && r === 7 && c === 4) {
      if (s.castling.wK && s.board[indexOf(7, 5)] === "" && s.board[indexOf(7, 6)] === "" && s.board[indexOf(7, 7)] === "WR") {
        moves.push({ from: fromIdx, to: indexOf(7, 6) });
      }
      if (s.castling.wQ && s.board[indexOf(7, 3)] === "" && s.board[indexOf(7, 2)] === "" && s.board[indexOf(7, 1)] === "" && s.board[indexOf(7, 0)] === "WR") {
        moves.push({ from: fromIdx, to: indexOf(7, 2) });
      }
    } else if (side === "B" && r === 0 && c === 4) {
      if (s.castling.bK && s.board[indexOf(0, 5)] === "" && s.board[indexOf(0, 6)] === "" && s.board[indexOf(0, 7)] === "BR") {
        moves.push({ from: fromIdx, to: indexOf(0, 6) });
      }
      if (s.castling.bQ && s.board[indexOf(0, 3)] === "" && s.board[indexOf(0, 2)] === "" && s.board[indexOf(0, 1)] === "" && s.board[indexOf(0, 0)] === "BR") {
        moves.push({ from: fromIdx, to: indexOf(0, 2) });
      }
    }
  }

  return moves;
}

function addPawnMove(out: Move[], from: number, to: number, isPromotion: boolean) {
  if (isPromotion) {
    for (const p of ["Q", "R", "B", "N"] as const) {
      out.push({ from, to, promotion: p });
    }
  } else {
    out.push({ from, to });
  }
}

// ---------------------------------------------------------------------------
// Attack detection (for check, castle-pass-through, etc.)
// ---------------------------------------------------------------------------

/**
 * Returns true if `side`'s pieces attack `square` in this board. Does NOT
 * filter by self-check. Used to test king safety + castle pass-through.
 */
export function isSquareAttacked(board: Board, square: number, attacker: Side): boolean {
  const [tr, tc] = rowColOf(square);

  // Pawn attacks (an enemy pawn one rank closer to us, diagonal)
  const pawnDir = attacker === "W" ? 1 : -1; // attacker pawn's forward dir is "toward us"
  for (const dc of [-1, 1]) {
    const r = tr + pawnDir;
    const c = tc + dc;
    if (inBounds(r, c) && board[indexOf(r, c)] === `${attacker}P`) return true;
  }

  // Knight
  for (const [dr, dc] of [
    [-2, -1], [-2, 1], [-1, -2], [-1, 2],
    [1, -2], [1, 2], [2, -1], [2, 1],
  ]) {
    const r = tr + dr;
    const c = tc + dc;
    if (inBounds(r, c) && board[indexOf(r, c)] === `${attacker}N`) return true;
  }

  // King (one step in any direction)
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = tr + dr;
      const c = tc + dc;
      if (inBounds(r, c) && board[indexOf(r, c)] === `${attacker}K`) return true;
    }
  }

  // Sliding: rook/queen straight, bishop/queen diagonals
  const straight: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dr, dc] of straight) {
    let r = tr + dr;
    let c = tc + dc;
    while (inBounds(r, c)) {
      const p = board[indexOf(r, c)];
      if (p !== "") {
        if (p === `${attacker}R` || p === `${attacker}Q`) return true;
        break;
      }
      r += dr;
      c += dc;
    }
  }
  const diag: [number, number][] = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  for (const [dr, dc] of diag) {
    let r = tr + dr;
    let c = tc + dc;
    while (inBounds(r, c)) {
      const p = board[indexOf(r, c)];
      if (p !== "") {
        if (p === `${attacker}B` || p === `${attacker}Q`) return true;
        break;
      }
      r += dr;
      c += dc;
    }
  }

  return false;
}

export function findKing(board: Board, side: Side): number {
  const king = `${side}K` as Piece;
  for (let i = 0; i < 64; i++) if (board[i] === king) return i;
  return -1;
}

export function isInCheck(state: ChessState, side: Side): boolean {
  const k = findKing(state.board, side);
  if (k < 0) return false;
  return isSquareAttacked(state.board, k, opposite(side));
}

// ---------------------------------------------------------------------------
// Apply move + legality filter
// ---------------------------------------------------------------------------

/**
 * Applies a move to the state, mutating + returning a new state. Updates
 * castling rights, en-passant target, halfmove clock, fullmove number,
 * and pushes to positionHistory.
 *
 * Assumes the move is at least pseudolegal — does NOT verify check status.
 * Use `legalMoves(state)` to enumerate legal moves first.
 */
export function applyMove(state: ChessState, move: Move): ChessState {
  const next = cloneState(state);
  const piece = next.board[move.from];
  if (piece === "") throw new Error(`applyMove: empty from square ${move.from}`);
  const side = piece[0] as Side;
  const kind = piece[1] as PieceLetter;
  const target = next.board[move.to];
  const [fr, fc] = rowColOf(move.from);
  const [tr, tc] = rowColOf(move.to);

  // 50-move clock: resets on pawn move or capture, otherwise increments.
  const isCapture = target !== "" || (kind === "P" && move.to === next.enPassantTarget);
  if (kind === "P" || isCapture) {
    next.halfmoveClock = 0;
  } else {
    next.halfmoveClock += 1;
  }

  // Move the piece
  next.board[move.from] = "";
  next.board[move.to] = piece;

  // Castling: move the rook
  if (kind === "K" && Math.abs(tc - fc) === 2) {
    if (side === "W" && tr === 7 && tc === 6) {
      // O-O
      next.board[indexOf(7, 5)] = "WR";
      next.board[indexOf(7, 7)] = "";
    } else if (side === "W" && tr === 7 && tc === 2) {
      // O-O-O
      next.board[indexOf(7, 3)] = "WR";
      next.board[indexOf(7, 0)] = "";
    } else if (side === "B" && tr === 0 && tc === 6) {
      next.board[indexOf(0, 5)] = "BR";
      next.board[indexOf(0, 7)] = "";
    } else if (side === "B" && tr === 0 && tc === 2) {
      next.board[indexOf(0, 3)] = "BR";
      next.board[indexOf(0, 0)] = "";
    }
  }

  // En passant capture: clear the captured pawn (which is NOT on the to-square)
  if (kind === "P" && move.to === state.enPassantTarget) {
    // The captured pawn is one rank closer to the moving side.
    const capturedRow = side === "W" ? tr + 1 : tr - 1;
    next.board[indexOf(capturedRow, tc)] = "";
  }

  // Promotion
  if (kind === "P" && (tr === 0 || tr === 7)) {
    const promo = move.promotion ?? "Q";
    next.board[move.to] = `${side}${promo}` as Piece;
  }

  // Update castling rights — lose them when the king or rook moves, or
  // when a rook is captured on its home square.
  if (kind === "K") {
    if (side === "W") {
      next.castling.wK = false;
      next.castling.wQ = false;
    } else {
      next.castling.bK = false;
      next.castling.bQ = false;
    }
  }
  if (move.from === indexOf(7, 0) || move.to === indexOf(7, 0)) next.castling.wQ = false;
  if (move.from === indexOf(7, 7) || move.to === indexOf(7, 7)) next.castling.wK = false;
  if (move.from === indexOf(0, 0) || move.to === indexOf(0, 0)) next.castling.bQ = false;
  if (move.from === indexOf(0, 7) || move.to === indexOf(0, 7)) next.castling.bK = false;

  // En passant target for the NEXT move: only set if a pawn just made a
  // two-square advance.
  if (kind === "P" && Math.abs(tr - fr) === 2) {
    next.enPassantTarget = indexOf((tr + fr) / 2, tc);
  } else {
    next.enPassantTarget = null;
  }

  // Turn + fullmove counter
  if (next.turn === "B") next.fullmoveNumber += 1;
  next.turn = opposite(side);
  next.lastMove = { from: move.from, to: move.to, promotion: move.promotion };

  // Push to position history for threefold repetition.
  next.positionHistory.push(
    hashState(next.board, next.turn, next.castling, next.enPassantTarget),
  );

  return next;
}

/**
 * Returns true if this move (assumed pseudolegal) would leave the moving
 * side's king in check. Used to filter out illegal moves.
 */
function leavesOwnKingInCheck(state: ChessState, move: Move): boolean {
  // For castling, we also need to check that the king didn't pass through
  // an attacked square. legalMoves() handles that.
  const test = applyMove(state, move);
  // After applyMove, turn flipped; the side that moved is opposite(test.turn).
  return isInCheck(test, opposite(test.turn));
}

/**
 * All legal moves for the side to move.
 */
export function legalMoves(state: ChessState): Move[] {
  const out: Move[] = [];
  for (let i = 0; i < 64; i++) {
    if (sideOf(state.board[i]) !== state.turn) continue;
    const piece = state.board[i];
    if (piece === "") continue;
    for (const m of pseudoMoves(state, i)) {
      // Castling: also verify the king isn't currently in check and doesn't
      // pass through an attacked square.
      if ((piece[1] as PieceLetter) === "K" && Math.abs((m.to % 8) - (m.from % 8)) === 2) {
        if (isInCheck(state, state.turn)) continue;
        const passRow = Math.floor(m.from / 8);
        const passCol = (m.from % 8) + ((m.to % 8) > (m.from % 8) ? 1 : -1);
        const passIdx = passRow * 8 + passCol;
        if (isSquareAttacked(state.board, passIdx, opposite(state.turn))) continue;
        // The destination check happens via leavesOwnKingInCheck below.
      }
      if (!leavesOwnKingInCheck(state, m)) out.push(m);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

/**
 * Returns true if neither side has enough material to deliver checkmate.
 * Covers: K-K, K-K+B, K-K+N, K+B-K+B (bishops on same color).
 */
function isInsufficientMaterial(board: Board): boolean {
  const pieces: { piece: Piece; square: number }[] = [];
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p === "") continue;
    if (p[1] === "P" || p[1] === "R" || p[1] === "Q") return false; // mateable material
    pieces.push({ piece: p, square: i });
  }
  // Only kings + (optional) minors remain.
  if (pieces.length === 2) return true; // K-K
  if (pieces.length === 3) {
    return pieces.some((x) => x.piece[1] === "B" || x.piece[1] === "N");
  }
  if (pieces.length === 4) {
    // K+B vs K+B with bishops on the same color.
    const bishops = pieces.filter((x) => x.piece[1] === "B");
    if (bishops.length !== 2) return false;
    if (bishops[0].piece[0] === bishops[1].piece[0]) return false; // same side, not a draw scenario
    const colorOf = (sq: number) => (Math.floor(sq / 8) + (sq % 8)) % 2;
    return colorOf(bishops[0].square) === colorOf(bishops[1].square);
  }
  return false;
}

export function checkResult(state: ChessState): ChessResult {
  // 50-move rule (100 half-moves without a pawn move or capture)
  if (state.halfmoveClock >= 100) {
    return { status: "draw", reason: "fifty_move" };
  }
  // Threefold repetition
  const last = state.positionHistory[state.positionHistory.length - 1];
  if (
    last &&
    state.positionHistory.filter((h) => h === last).length >= 3
  ) {
    return { status: "draw", reason: "threefold" };
  }
  // Insufficient material
  if (isInsufficientMaterial(state.board)) {
    return { status: "draw", reason: "insufficient_material" };
  }
  // Check checkmate / stalemate
  const moves = legalMoves(state);
  if (moves.length === 0) {
    if (isInCheck(state, state.turn)) {
      return { status: "win", winner: opposite(state.turn), reason: "checkmate" };
    }
    return { status: "draw", reason: "stalemate" };
  }
  return { status: "ongoing" };
}

// ---------------------------------------------------------------------------
// Position hashing for threefold repetition
// ---------------------------------------------------------------------------

/**
 * Compact string that identifies a position for repetition purposes:
 * board contents, side to move, castling rights, en-passant target.
 * Two positions that differ only in halfmove clock or move number are
 * considered "the same position" per FIDE.
 */
export function hashState(
  board: Board,
  turn: Side,
  castling: CastlingRights,
  enPassantTarget: number | null,
): string {
  const cr =
    (castling.wK ? "K" : "") +
    (castling.wQ ? "Q" : "") +
    (castling.bK ? "k" : "") +
    (castling.bQ ? "q" : "") || "-";
  return `${board.join(",")}|${turn}|${cr}|${enPassantTarget ?? "-"}`;
}

// ---------------------------------------------------------------------------
// ASCII rendering for tests + debugging
// ---------------------------------------------------------------------------

const PIECE_GLYPHS: Record<Cell, string> = {
  "": ".",
  WP: "P", WN: "N", WB: "B", WR: "R", WQ: "Q", WK: "K",
  BP: "p", BN: "n", BB: "b", BR: "r", BQ: "q", BK: "k",
};

export function renderBoard(board: Board): string {
  const rows: string[] = [];
  for (let r = 0; r < 8; r++) {
    const row: string[] = [];
    for (let c = 0; c < 8; c++) row.push(PIECE_GLYPHS[board[indexOf(r, c)]]);
    rows.push(row.join(" "));
  }
  return rows.join("\n");
}

// ---------------------------------------------------------------------------
// boardgame.io Game definition
// ---------------------------------------------------------------------------

/**
 * Move arg shape: { from: "e2", to: "e4", promotion?: "Q"|"R"|"B"|"N" }
 *
 * We delegate fully to the pure engine: parse args, find the matching legal
 * move, apply it. INVALID_MOVE on any mismatch.
 */
export const game: Game<ChessState> = {
  name: "chess",
  setup: () => startingState(),
  turn: { minMoves: 1, maxMoves: 1 },
  moves: {
    play: ({ G, playerID }, raw: unknown) => {
      // playerID "0" = White, "1" = Black.
      const expectedSide: Side = playerID === "0" ? "W" : "B";
      if (G.turn !== expectedSide) return INVALID_MOVE;
      const arg = raw as { from?: unknown; to?: unknown; promotion?: unknown };
      if (typeof arg.from !== "string" || typeof arg.to !== "string") return INVALID_MOVE;
      let fromIdx: number;
      let toIdx: number;
      try {
        fromIdx = squareIndex(arg.from);
        toIdx = squareIndex(arg.to);
      } catch {
        return INVALID_MOVE;
      }
      const promo = arg.promotion;
      const promotion =
        promo === "Q" || promo === "R" || promo === "B" || promo === "N"
          ? promo
          : undefined;

      // Find a matching legal move. We don't trust the client to know it's
      // legal — we re-derive from the state.
      const legal = legalMoves(G);
      const match = legal.find(
        (m) =>
          m.from === fromIdx &&
          m.to === toIdx &&
          (m.promotion ?? null) === (promotion ?? null),
      );
      if (!match) return INVALID_MOVE;

      // Apply by mutating G in place (boardgame.io uses Immer under the hood).
      const next = applyMove(G, match);
      G.board = next.board;
      G.turn = next.turn;
      G.castling = next.castling;
      G.enPassantTarget = next.enPassantTarget;
      G.halfmoveClock = next.halfmoveClock;
      G.fullmoveNumber = next.fullmoveNumber;
      G.positionHistory = next.positionHistory;
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
