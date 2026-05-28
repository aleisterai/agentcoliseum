/**
 * Yoté — West African capture game. Pure rules engine + boardgame.io game.
 *
 * Board: 5 rows × 6 columns (30 cells), all empty at start. Each player holds
 * 12 pieces in reserve. Players alternate turns. On your turn you do ONE of:
 *
 *   • DROP   — place a reserve piece on any empty cell.
 *   • MOVE   — slide an on-board piece to an orthogonally-adjacent empty cell.
 *   • CAPTURE — jump orthogonally over an adjacent enemy piece into the empty
 *               cell beyond it. You remove the jumped piece AND, as Yoté's
 *               signature "wild remove", one additional enemy piece of your
 *               choice from anywhere on the board (if any other enemy exists).
 *
 * Captures are optional (this is the standard, non-forced variant).
 *
 * Win: reduce the opponent to ZERO pieces (board + reserve), or leave the
 * player-to-move with no legal move (they lose). A move cap forces a draw to
 * guarantee on-chain-verifiable termination.
 *
 * Move payloads (see api-contract.ts):
 *   { kind: "drop",    to }
 *   { kind: "move",    from, to }
 *   { kind: "capture", from, to, remove? }   // `over` is implied (the middle
 *                                            // cell); `remove` is the wild
 *                                            // bonus target (optional/none).
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const ROWS = 5;
export const COLS = 6;
export const N = ROWS * COLS; // 30
export const PIECES_PER_PLAYER = 12;
/** Hard cap on plies — beyond this the game is declared a draw. */
export const MAX_MOVES = 200;

export type PlayerId = "0" | "1";
export type Cell = "" | "0" | "1";

export type YoteMove =
  | { kind: "drop"; to: number }
  | { kind: "move"; from: number; to: number }
  | { kind: "capture"; from: number; to: number; remove?: number | null };

export interface YoteState {
  board: Cell[]; // length N
  reserve: { "0": number; "1": number };
  turn: PlayerId;
  lastMove: YoteMove | null;
  moveCount: number;
}

export type YoteResult =
  | { status: "ongoing" }
  | { status: "win"; winner: PlayerId }
  | { status: "draw" };

export function opposite(p: PlayerId): PlayerId {
  return p === "0" ? "1" : "0";
}

export function rowOf(idx: number): number {
  return Math.floor(idx / COLS);
}
export function colOf(idx: number): number {
  return idx % COLS;
}
export function idxOf(row: number, col: number): number {
  return row * COLS + col;
}
export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < ROWS && col >= 0 && col < COLS;
}

export function startingState(): YoteState {
  return {
    board: Array<Cell>(N).fill(""),
    reserve: { "0": PIECES_PER_PLAYER, "1": PIECES_PER_PLAYER },
    turn: "0",
    lastMove: null,
    moveCount: 0,
  };
}

export function cloneState(s: YoteState): YoteState {
  return {
    board: s.board.slice(),
    reserve: { "0": s.reserve["0"], "1": s.reserve["1"] },
    turn: s.turn,
    lastMove: s.lastMove ? { ...s.lastMove } : null,
    moveCount: s.moveCount,
  };
}

/** Orthogonal neighbours of a cell (as flat indices). */
export function neighbours(idx: number): number[] {
  const r = rowOf(idx);
  const c = colOf(idx);
  const out: number[] = [];
  const deltas: ReadonlyArray<readonly [number, number]> = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  for (const [dr, dc] of deltas) {
    if (inBounds(r + dr, c + dc)) out.push(idxOf(r + dr, c + dc));
  }
  return out;
}

/** Count a player's pieces currently on the board. */
export function boardCount(s: YoteState, p: PlayerId): number {
  let n = 0;
  for (const cell of s.board) if (cell === p) n++;
  return n;
}

/** Total pieces a player still controls (board + reserve). */
export function totalPieces(s: YoteState, p: PlayerId): number {
  return boardCount(s, p) + s.reserve[p];
}

/**
 * For a capture from `from` to `to` (two cells away orthogonally), return the
 * index of the jumped-over middle cell, or null if from→to isn't a valid
 * straight 2-step orthogonal jump.
 */
export function jumpedCell(from: number, to: number): number | null {
  const fr = rowOf(from);
  const fc = colOf(from);
  const tr = rowOf(to);
  const tc = colOf(to);
  const dr = tr - fr;
  const dc = tc - fc;
  if (dr === 0 && Math.abs(dc) === 2) return idxOf(fr, fc + dc / 2);
  if (dc === 0 && Math.abs(dr) === 2) return idxOf(fr + dr / 2, fc);
  return null;
}

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

export function isLegalMove(s: YoteState, m: YoteMove): boolean {
  const me = s.turn;
  const foe = opposite(me);

  if (m.kind === "drop") {
    if (!Number.isInteger(m.to) || m.to < 0 || m.to >= N) return false;
    if (s.reserve[me] <= 0) return false;
    return s.board[m.to] === "";
  }

  if (m.kind === "move") {
    if (!Number.isInteger(m.from) || m.from < 0 || m.from >= N) return false;
    if (!Number.isInteger(m.to) || m.to < 0 || m.to >= N) return false;
    if (s.board[m.from] !== me) return false;
    if (s.board[m.to] !== "") return false;
    return neighbours(m.from).includes(m.to);
  }

  // capture
  if (!Number.isInteger(m.from) || m.from < 0 || m.from >= N) return false;
  if (!Number.isInteger(m.to) || m.to < 0 || m.to >= N) return false;
  if (s.board[m.from] !== me) return false;
  if (s.board[m.to] !== "") return false;
  const over = jumpedCell(m.from, m.to);
  if (over === null) return false;
  if (s.board[over] !== foe) return false;
  // `remove` (wild bonus): must be an enemy piece other than the jumped one,
  // OR null/undefined when no other enemy piece exists.
  const otherEnemies: number[] = [];
  for (let i = 0; i < N; i++) if (i !== over && s.board[i] === foe) otherEnemies.push(i);
  if (m.remove == null) return otherEnemies.length === 0;
  return otherEnemies.includes(m.remove);
}

export function legalMoves(s: YoteState): YoteMove[] {
  const me = s.turn;
  const foe = opposite(me);
  const out: YoteMove[] = [];

  // Drops
  if (s.reserve[me] > 0) {
    for (let i = 0; i < N; i++) if (s.board[i] === "") out.push({ kind: "drop", to: i });
  }

  // Moves + captures from each of my pieces
  for (let from = 0; from < N; from++) {
    if (s.board[from] !== me) continue;
    const fr = rowOf(from);
    const fc = colOf(from);
    const dirs: ReadonlyArray<readonly [number, number]> = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (const [dr, dc] of dirs) {
      // simple move (1 step)
      const mr = fr + dr;
      const mc = fc + dc;
      if (inBounds(mr, mc) && s.board[idxOf(mr, mc)] === "") {
        out.push({ kind: "move", from, to: idxOf(mr, mc) });
      }
      // capture (2 steps over an enemy)
      const or = fr + dr;
      const oc = fc + dc;
      const lr = fr + 2 * dr;
      const lc = fc + 2 * dc;
      if (
        inBounds(or, oc) &&
        inBounds(lr, lc) &&
        s.board[idxOf(or, oc)] === foe &&
        s.board[idxOf(lr, lc)] === ""
      ) {
        const over = idxOf(or, oc);
        const to = idxOf(lr, lc);
        const otherEnemies: number[] = [];
        for (let i = 0; i < N; i++) if (i !== over && s.board[i] === foe) otherEnemies.push(i);
        if (otherEnemies.length === 0) {
          out.push({ kind: "capture", from, to, remove: null });
        } else {
          for (const rem of otherEnemies) out.push({ kind: "capture", from, to, remove: rem });
        }
      }
    }
  }

  return out;
}

export function hasLegalMove(s: YoteState): boolean {
  const me = s.turn;
  if (s.reserve[me] > 0) {
    for (let i = 0; i < N; i++) if (s.board[i] === "") return true;
  }
  for (let from = 0; from < N; from++) {
    if (s.board[from] !== me) continue;
    for (const nb of neighbours(from)) if (s.board[nb] === "") return true;
    // capture availability
    const fr = rowOf(from);
    const fc = colOf(from);
    const foe = opposite(me);
    const dirs: ReadonlyArray<readonly [number, number]> = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (const [dr, dc] of dirs) {
      const or = fr + dr;
      const oc = fc + dc;
      const lr = fr + 2 * dr;
      const lc = fc + 2 * dc;
      if (
        inBounds(or, oc) &&
        inBounds(lr, lc) &&
        s.board[idxOf(or, oc)] === foe &&
        s.board[idxOf(lr, lc)] === ""
      ) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export function applyMove(s: YoteState, m: YoteMove): YoteState {
  if (!isLegalMove(s, m)) {
    throw new Error(`illegal yote move ${JSON.stringify(m)}`);
  }
  const me = s.turn;
  const next = cloneState(s);

  if (m.kind === "drop") {
    next.board[m.to] = me;
    next.reserve[me] -= 1;
  } else if (m.kind === "move") {
    next.board[m.to] = me;
    next.board[m.from] = "";
  } else {
    // capture
    const over = jumpedCell(m.from, m.to)!;
    next.board[m.to] = me;
    next.board[m.from] = "";
    next.board[over] = ""; // jumped piece removed
    if (m.remove != null) next.board[m.remove] = ""; // wild bonus removal
  }

  next.lastMove = { ...m };
  next.moveCount = s.moveCount + 1;
  next.turn = opposite(me);
  return next;
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

export function checkResult(s: YoteState): YoteResult {
  // A player with zero total pieces has lost. (Check the side that just moved
  // first so a capture that wipes the opponent is an immediate win.)
  const p0 = totalPieces(s, "0");
  const p1 = totalPieces(s, "1");
  if (p0 === 0 && p1 === 0) return { status: "draw" };
  if (p1 === 0) return { status: "win", winner: "0" };
  if (p0 === 0) return { status: "win", winner: "1" };

  // Stalemate: the player to move has no legal move → they lose.
  if (!hasLegalMove(s)) return { status: "win", winner: opposite(s.turn) };

  if (s.moveCount >= MAX_MOVES) return { status: "draw" };
  return { status: "ongoing" };
}

// ---------------------------------------------------------------------------
// boardgame.io
// ---------------------------------------------------------------------------

export const game: Game<YoteState> = {
  name: "yote",
  setup: () => startingState(),
  turn: { minMoves: 1, maxMoves: 1 },
  moves: {
    play: ({ G, playerID }, raw: unknown) => {
      if (G.turn !== playerID) return INVALID_MOVE;
      const m = raw as YoteMove;
      if (!m || typeof m !== "object" || !isLegalMove(G, m)) return INVALID_MOVE;
      const next = applyMove(G, m);
      G.board = next.board;
      G.reserve = next.reserve;
      G.turn = next.turn;
      G.lastMove = next.lastMove;
      G.moveCount = next.moveCount;
    },
  },
  endIf: ({ G }) => {
    const r = checkResult(G);
    if (r.status === "win") return { winner: r.winner };
    if (r.status === "draw") return { draw: true };
  },
};
