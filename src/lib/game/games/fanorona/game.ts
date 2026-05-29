/**
 * Fanorona (Fanoron-Tsivy) — the national board game of Madagascar.
 * Pure rules engine + boardgame.io game. Deterministic, perfect-information.
 *
 * Board: 5 rows × 9 columns = 45 intersections (`index = row*9 + col`).
 * Lines connect every orthogonal neighbour; diagonals connect only at
 * "strong" intersections — points where `(row + col)` is even (corners,
 * centre, edge-midpoints). At a strong point a piece can move in all 8
 * directions; at a "weak" point only the 4 orthogonal directions.
 *
 * Setup (22 pieces each, centre empty), point of view player 0 at the bottom:
 *
 *     1 1 1 1 1 1 1 1 1      row 0  (player 1)
 *     1 1 1 1 1 1 1 1 1      row 1
 *     0 1 0 1 . 1 0 1 0      row 2  (mixed, centre empty)
 *     0 0 0 0 0 0 0 0 0      row 3
 *     0 0 0 0 0 0 0 0 0      row 4  (player 0)
 *
 * A turn moves ONE piece one step to an adjacent empty connected point and
 * captures by one of two mechanisms:
 *
 *   • APPROACH  — move toward an enemy line; the contiguous enemy run that
 *                 begins on the cell *just beyond* your landing point (in the
 *                 direction you moved) is captured.
 *   • WITHDRAW  — move away from an enemy line; the contiguous enemy run that
 *                 begins on the cell *just behind* your start point (opposite
 *                 the direction you moved) is captured.
 *
 * Mandatory capture: if any capturing move exists, you may NOT play a
 * non-capturing (paika) move. A single piece may keep capturing in the same
 * turn (a chain), subject to: each continuation must itself capture, must not
 * move in the same direction as the immediately preceding hop, and must not
 * land on a point already visited this turn. Continuing is optional — the
 * player chooses when to stop.
 *
 * Win: capture all of the opponent's pieces, or leave them with no legal move.
 * A ply cap forces a draw to guarantee on-chain-verifiable termination.
 *
 * Move payload (see api-contract.ts):
 *   { from, steps: [{ to, capture: "approach" | "withdraw" }, ...] }   // capture chain
 *   { from, steps: [{ to, capture: null }] }                          // single paika (only when no capture exists)
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const ROWS = 5;
export const COLS = 9;
export const N = ROWS * COLS; // 45
export const PIECES_EACH = 22;
/** Hard cap on plies — beyond this the game is declared a draw. */
export const MAX_MOVES = 300;
/** Safety bound on capture-chain enumeration depth (chains are short). */
const MAX_CHAIN = 16;
/** Safety bound on how many distinct legal turns we enumerate for bots. */
const MAX_TURNS = 4000;

export type PlayerId = "0" | "1";
export type Cell = "" | "0" | "1";
export type CaptureKind = "approach" | "withdraw";

export interface FanoronaStep {
  to: number;
  /** null = paika (non-capturing). Only legal as a lone hop when no capture exists. */
  capture: CaptureKind | null;
}

export interface FanoronaMove {
  from: number;
  steps: FanoronaStep[];
}

export interface FanoronaState {
  board: Cell[]; // length N
  turn: PlayerId;
  lastMove: { from: number; to: number; captured: number } | null;
  moveCount: number;
}

export type FanoronaResult =
  | { status: "ongoing" }
  | { status: "win"; winner: PlayerId }
  | { status: "draw" };

export type ApplyResult =
  | { ok: true; next: FanoronaState }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

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
/** A "strong" intersection (8-connected) is one where (row + col) is even. */
export function isStrong(idx: number): boolean {
  return (rowOf(idx) + colOf(idx)) % 2 === 0;
}

/** 8 unit directions; 0..3 orthogonal, 4..7 diagonal. */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], // 0 N
  [1, 0], // 1 S
  [0, -1], // 2 W
  [0, 1], // 3 E
  [-1, -1], // 4 NW
  [-1, 1], // 5 NE
  [1, -1], // 6 SW
  [1, 1], // 7 SE
];

/**
 * Direction index for a single connected step `cur`→`to`, or -1 if `to` is
 * not a legal adjacent point (not a unit step, off-board, or a diagonal from
 * a weak point).
 */
export function stepDir(cur: number, to: number): number {
  if (!Number.isInteger(to) || to < 0 || to >= N) return -1;
  const dr = rowOf(to) - rowOf(cur);
  const dc = colOf(to) - colOf(cur);
  if (dr < -1 || dr > 1 || dc < -1 || dc > 1) return -1;
  if (dr === 0 && dc === 0) return -1;
  let dirIdx = -1;
  for (let d = 0; d < 8; d++) {
    if (DIRS[d][0] === dr && DIRS[d][1] === dc) {
      dirIdx = d;
      break;
    }
  }
  if (dirIdx < 0) return -1;
  if (dirIdx >= 4 && !isStrong(cur)) return -1; // diagonal only from strong points
  return dirIdx;
}

/** Connected empty unit-neighbours of `cur`, as {to, dirIdx}. */
function neighborHops(board: Cell[], cur: number): { to: number; dirIdx: number }[] {
  const out: { to: number; dirIdx: number }[] = [];
  const r = rowOf(cur);
  const c = colOf(cur);
  const strong = isStrong(cur);
  for (let d = 0; d < 8; d++) {
    if (d >= 4 && !strong) continue;
    const nr = r + DIRS[d][0];
    const nc = c + DIRS[d][1];
    if (!inBounds(nr, nc)) continue;
    const to = idxOf(nr, nc);
    if (board[to] !== "") continue;
    out.push({ to, dirIdx: d });
  }
  return out;
}

/**
 * Enemy cells captured by moving `from` in direction `dirIdx` (landing on the
 * adjacent empty cell). `approach` = the run beyond the landing; `withdraw` =
 * the run behind the start. Either may be empty.
 */
export function captureCells(
  board: Cell[],
  me: PlayerId,
  from: number,
  dirIdx: number,
): { approach: number[]; withdraw: number[] } {
  const foe = opposite(me);
  const [dr, dc] = DIRS[dirIdx];
  const fr = rowOf(from);
  const fc = colOf(from);

  // Approach: starts on the cell two steps along the direction (just beyond
  // the landing cell `from + dir`).
  const approach: number[] = [];
  let ar = fr + 2 * dr;
  let ac = fc + 2 * dc;
  while (inBounds(ar, ac) && board[idxOf(ar, ac)] === foe) {
    approach.push(idxOf(ar, ac));
    ar += dr;
    ac += dc;
  }

  // Withdraw: starts on the cell one step opposite the direction (just behind
  // the start cell).
  const withdraw: number[] = [];
  let wr = fr - dr;
  let wc = fc - dc;
  while (inBounds(wr, wc) && board[idxOf(wr, wc)] === foe) {
    withdraw.push(idxOf(wr, wc));
    wr -= dr;
    wc -= dc;
  }

  return { approach, withdraw };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function startingState(): FanoronaState {
  const board = Array<Cell>(N).fill("");
  // Player 1 fills the top two rows; player 0 the bottom two.
  for (let c = 0; c < COLS; c++) {
    board[idxOf(0, c)] = "1";
    board[idxOf(1, c)] = "1";
    board[idxOf(3, c)] = "0";
    board[idxOf(4, c)] = "0";
  }
  // Middle row 2 (left-right mirror symmetric, centre empty): 0 1 0 1 . 1 0 1 0
  const mid: Cell[] = ["0", "1", "0", "1", "", "1", "0", "1", "0"];
  for (let c = 0; c < COLS; c++) board[idxOf(2, c)] = mid[c];
  return { board, turn: "0", lastMove: null, moveCount: 0 };
}

export function cloneState(s: FanoronaState): FanoronaState {
  return {
    board: s.board.slice(),
    turn: s.turn,
    lastMove: s.lastMove ? { ...s.lastMove } : null,
    moveCount: s.moveCount,
  };
}

export function pieceCount(s: FanoronaState, p: PlayerId): number {
  let n = 0;
  for (const cell of s.board) if (cell === p) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Legality / enumeration
// ---------------------------------------------------------------------------

/** Does `player` have at least one capturing move available? */
export function hasAnyCapture(s: FanoronaState, player: PlayerId): boolean {
  const board = s.board;
  for (let from = 0; from < N; from++) {
    if (board[from] !== player) continue;
    for (const { dirIdx } of neighborHops(board, from)) {
      const { approach, withdraw } = captureCells(board, player, from, dirIdx);
      if (approach.length > 0 || withdraw.length > 0) return true;
    }
  }
  return false;
}

/** Does `player` have any legal move (capture or paika)? */
export function hasLegalMove(s: FanoronaState, player: PlayerId): boolean {
  if (hasAnyCapture(s, player)) return true;
  const board = s.board;
  for (let from = 0; from < N; from++) {
    if (board[from] !== player) continue;
    if (neighborHops(board, from).length > 0) return true;
  }
  return false;
}

/**
 * Enumerate every legal full turn for `player`. When captures exist, returns
 * every capturing chain (and each of its stop-points); otherwise returns every
 * single paika hop. Bounded by MAX_TURNS for safety.
 */
export function legalTurns(s: FanoronaState, player: PlayerId): FanoronaMove[] {
  const board = s.board;
  const out: FanoronaMove[] = [];

  if (!hasAnyCapture(s, player)) {
    for (let from = 0; from < N; from++) {
      if (board[from] !== player) continue;
      for (const { to } of neighborHops(board, from)) {
        out.push({ from, steps: [{ to, capture: null }] });
        if (out.length >= MAX_TURNS) return out;
      }
    }
    return out;
  }

  for (let from = 0; from < N; from++) {
    if (board[from] !== player) continue;
    extendChain(board, player, from, from, new Set([from]), -1, [], out);
    if (out.length >= MAX_TURNS) return out;
  }
  return out;
}

function extendChain(
  board: Cell[],
  me: PlayerId,
  origin: number,
  cur: number,
  visited: Set<number>,
  lastDir: number,
  chain: FanoronaStep[],
  out: FanoronaMove[],
): void {
  if (out.length >= MAX_TURNS || chain.length >= MAX_CHAIN) return;
  for (const { to, dirIdx } of neighborHops(board, cur)) {
    if (dirIdx === lastDir) continue; // no same direction twice in a row
    if (visited.has(to)) continue; // no revisiting
    const { approach, withdraw } = captureCells(board, me, cur, dirIdx);
    const kinds: CaptureKind[] = [];
    if (approach.length > 0) kinds.push("approach");
    if (withdraw.length > 0) kinds.push("withdraw");
    for (const kind of kinds) {
      const removed = kind === "approach" ? approach : withdraw;
      const nb = board.slice();
      nb[cur] = "";
      nb[to] = me;
      for (const cell of removed) nb[cell] = "";
      const nextChain = [...chain, { to, capture: kind }];
      out.push({ from: origin, steps: nextChain }); // stopping here is legal
      if (out.length >= MAX_TURNS) return;
      const nv = new Set(visited);
      nv.add(to);
      extendChain(nb, me, origin, to, nv, dirIdx, nextChain, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Apply (independent validation — does not rely on enumeration)
// ---------------------------------------------------------------------------

export function applyTurn(
  s: FanoronaState,
  player: PlayerId,
  move: FanoronaMove,
): ApplyResult {
  if (s.turn !== player) return { ok: false, error: "not your turn" };
  if (!move || typeof move !== "object" || !Array.isArray(move.steps)) {
    return { ok: false, error: "move must have a steps array" };
  }
  if (move.steps.length === 0) {
    return { ok: false, error: "steps must be non-empty" };
  }
  const from = move.from;
  if (!Number.isInteger(from) || from < 0 || from >= N) {
    return { ok: false, error: "from must be an integer 0..44" };
  }
  if (s.board[from] !== player) {
    return { ok: false, error: "from is not your piece" };
  }

  const capturesExist = hasAnyCapture(s, player);
  const board = s.board.slice();
  let cur = from;
  const visited = new Set<number>([from]);
  let lastDir = -1;
  let removedTotal = 0;

  for (let i = 0; i < move.steps.length; i++) {
    const st = move.steps[i];
    if (!st || typeof st !== "object") {
      return { ok: false, error: `step ${i}: must be an object` };
    }
    const to = st.to;
    const dirIdx = stepDir(cur, to);
    if (dirIdx < 0) {
      return { ok: false, error: `step ${i}: ${to} is not a connected adjacent point` };
    }
    if (board[to] !== "") {
      return { ok: false, error: `step ${i}: landing ${to} is not empty` };
    }
    if (visited.has(to)) {
      return { ok: false, error: `step ${i}: ${to} was already visited this turn` };
    }
    if (i > 0 && dirIdx === lastDir) {
      return { ok: false, error: `step ${i}: cannot move the same direction twice in a row` };
    }

    if (st.capture == null) {
      // Paika — only legal as a lone hop when no capture exists anywhere.
      if (capturesExist) {
        return { ok: false, error: "a capture is available — a non-capturing move is not allowed" };
      }
      if (move.steps.length !== 1) {
        return { ok: false, error: "a non-capturing (paika) move must be a single step" };
      }
      board[from] = "";
      board[to] = player;
      cur = to;
      continue;
    }

    if (st.capture !== "approach" && st.capture !== "withdraw") {
      return { ok: false, error: `step ${i}: capture must be "approach", "withdraw", or null` };
    }
    if (!capturesExist) {
      // Shouldn't reach here (no capturing hop could validate), but guard anyway.
      return { ok: false, error: "no capture is available" };
    }
    const { approach, withdraw } = captureCells(board, player, cur, dirIdx);
    const removed = st.capture === "approach" ? approach : withdraw;
    if (removed.length === 0) {
      return { ok: false, error: `step ${i}: ${st.capture} captures nothing here` };
    }
    board[cur] = "";
    board[to] = player;
    for (const cell of removed) board[cell] = "";
    removedTotal += removed.length;
    cur = to;
    visited.add(to);
    lastDir = dirIdx;
  }

  return {
    ok: true,
    next: {
      board,
      turn: opposite(player),
      lastMove: { from, to: cur, captured: removedTotal },
      moveCount: s.moveCount + 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

export function checkResult(s: FanoronaState): FanoronaResult {
  const c0 = pieceCount(s, "0");
  const c1 = pieceCount(s, "1");
  if (c1 === 0) return { status: "win", winner: "0" };
  if (c0 === 0) return { status: "win", winner: "1" };
  // The player to move with no legal move loses.
  if (!hasLegalMove(s, s.turn)) return { status: "win", winner: opposite(s.turn) };
  if (s.moveCount >= MAX_MOVES) return { status: "draw" };
  return { status: "ongoing" };
}

// ---------------------------------------------------------------------------
// boardgame.io
// ---------------------------------------------------------------------------

export const game: Game<FanoronaState> = {
  name: "fanorona",
  setup: () => startingState(),
  turn: { minMoves: 1, maxMoves: 1 },
  moves: {
    play: ({ G, playerID }, raw: unknown) => {
      if (G.turn !== playerID) return INVALID_MOVE;
      const m = raw as FanoronaMove;
      const res = applyTurn(G, playerID as PlayerId, m);
      if (!res.ok) return INVALID_MOVE;
      G.board = res.next.board;
      G.turn = res.next.turn;
      G.lastMove = res.next.lastMove;
      G.moveCount = res.next.moveCount;
    },
  },
  endIf: ({ G }) => {
    const r = checkResult(G);
    if (r.status === "win") return { winner: r.winner };
    if (r.status === "draw") return { draw: true };
  },
};
