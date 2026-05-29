/**
 * Agon ("Queen's Guard") — a 19th-century hexagonal strategy game. Pure rules
 * engine + boardgame.io game. Deterministic, perfect-information.
 *
 * The historical rules vary between sources, so this is Coliseum's **pinned**
 * ruleset — one internally-consistent, fully-documented version (see
 * rules.ts). The essence is faithful: race your Queen to the centre and ring
 * her with your six Guards, or flank the enemy Queen.
 *
 * Board: a hexagon of hexagons, 6 cells to a side → 91 cells in 6 concentric
 * rings (ring 0 = the single centre cell; rings 1..5 have 6,12,18,24,30). Cells
 * are indexed 0..90 in ring order. Cube coordinates (x+y+z=0) drive geometry;
 * a cell's ring = (|x|+|y|+|z|)/2.
 *
 * Pieces: each side has 1 Queen + 6 Guards, starting on opposite arcs of the
 * outer ring (point-symmetric, so neither side has an opening edge).
 *
 * Movement: one piece, one step per turn, to an empty adjacent cell that is
 * **not farther from the centre** — i.e. inward or along the same ring, never
 * outward.
 *
 * Custodial flank (applied only to the piece you just moved): if your move puts
 * an enemy piece directly between the piece you moved and another of your
 * pieces along a straight line of cells, that enemy is flanked.
 *   • a flanked Guard is sent back to the outer ring (it does not leave play);
 *   • a flanked Queen is captured — you win.
 * Moving your own piece into the middle of two enemies is safe.
 *
 * Win: (a) your Queen sits on the centre and all six ring-1 cells hold your
 * Guards; (b) you flank the enemy Queen; (c) the player to move has no legal
 * move (they lose). A ply cap forces a draw for verifiable termination.
 *
 * Move payload (see api-contract.ts): { from, to } — both cell indices 0..90.
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const RINGS = 6; // rings 0..5
export const N = 91; // total cells
export const MAX_MOVES = 300;

export type PlayerId = "0" | "1";
/** "" empty, or owner+kind: "0Q","0G","1Q","1G". */
export type Cell = "" | "0Q" | "0G" | "1Q" | "1G";

export interface AgonMove {
  from: number;
  to: number;
}

export interface AgonState {
  board: Cell[]; // length N
  turn: PlayerId;
  lastMove: { from: number; to: number; flanked: number[] } | null;
  moveCount: number;
}

export type AgonResult =
  | { status: "ongoing" }
  | { status: "win"; winner: PlayerId }
  | { status: "draw" };

export function opposite(p: PlayerId): PlayerId {
  return p === "0" ? "1" : "0";
}
export function ownerOf(cell: Cell): PlayerId | null {
  return cell === "" ? null : (cell[0] as PlayerId);
}
export function kindOf(cell: Cell): "Q" | "G" | null {
  return cell === "" ? null : (cell[1] as "Q" | "G");
}

// ---------------------------------------------------------------------------
// Board geometry (built once)
// ---------------------------------------------------------------------------

type Cube = readonly [number, number, number];
const CUBE_DIRS: ReadonlyArray<Cube> = [
  [1, -1, 0],
  [1, 0, -1],
  [0, 1, -1],
  [-1, 1, 0],
  [-1, 0, 1],
  [0, -1, 1],
];

function cubeRing(r: number): Cube[] {
  if (r === 0) return [[0, 0, 0]];
  const out: Cube[] = [];
  let cube: Cube = [CUBE_DIRS[4][0] * r, CUBE_DIRS[4][1] * r, CUBE_DIRS[4][2] * r];
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < r; j++) {
      out.push(cube);
      cube = [cube[0] + CUBE_DIRS[i][0], cube[1] + CUBE_DIRS[i][1], cube[2] + CUBE_DIRS[i][2]];
    }
  }
  return out;
}

const CELLS: Cube[] = [];
for (let r = 0; r < RINGS; r++) CELLS.push(...cubeRing(r));

const KEY = (c: Cube) => `${c[0]},${c[1]},${c[2]}`;
const COORD_TO_IDX = new Map<string, number>();
CELLS.forEach((c, i) => COORD_TO_IDX.set(KEY(c), i));

export const RING: number[] = CELLS.map(
  (c) => (Math.abs(c[0]) + Math.abs(c[1]) + Math.abs(c[2])) / 2,
);

/** 6 neighbour indices per cell, in CUBE_DIRS order; -1 where off-board. */
export const NEIGHBORS: number[][] = CELLS.map((c) =>
  CUBE_DIRS.map((d) => {
    const k = KEY([c[0] + d[0], c[1] + d[1], c[2] + d[2]]);
    return COORD_TO_IDX.has(k) ? (COORD_TO_IDX.get(k) as number) : -1;
  }),
);

export const CENTER = 0;
/** The six ring-1 cells (centre's neighbours). */
export const RING1: number[] = NEIGHBORS[CENTER].filter((i) => i >= 0);
/** Outer-ring (ring 5) cell indices, in generation order. */
export const OUTER: number[] = CELLS.map((_, i) => i).filter((i) => RING[i] === RINGS - 1);

/** Export pixel layout helpers for the board renderer. */
export function cubeToAxial(idx: number): { q: number; r: number } {
  const c = CELLS[idx];
  return { q: c[0], r: c[2] };
}

/** Axial (q,r) per cell index, in the engine's canonical order — drives the
 *  board renderer so board[i] maps to the correct hex. */
export const AXIAL: ReadonlyArray<{ q: number; r: number }> = CELLS.map((c) => ({
  q: c[0],
  r: c[2],
}));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function startingState(): AgonState {
  const board = Array<Cell>(N).fill("");
  // Player 0 on a 7-cell arc of the outer ring; player 1 on the diametrically
  // opposite arc (OUTER has 30 cells, so +15 is the 180° rotation). Queen in
  // the middle of each arc, three Guards either side. Point-symmetric.
  const place = (player: PlayerId, start: number) => {
    for (let k = 0; k < 7; k++) {
      const idx = OUTER[(start + k) % OUTER.length];
      board[idx] = (player + (k === 3 ? "Q" : "G")) as Cell;
    }
  };
  place("0", 0);
  place("1", 15);
  return { board, turn: "0", lastMove: null, moveCount: 0 };
}

export function cloneState(s: AgonState): AgonState {
  return {
    board: s.board.slice(),
    turn: s.turn,
    lastMove: s.lastMove ? { ...s.lastMove, flanked: s.lastMove.flanked.slice() } : null,
    moveCount: s.moveCount,
  };
}

/** Index of `player`'s queen, or -1 if it's been captured. */
export function queenCell(s: AgonState, player: PlayerId): number {
  const q = (player + "Q") as Cell;
  return s.board.indexOf(q);
}

// ---------------------------------------------------------------------------
// Legality / enumeration
// ---------------------------------------------------------------------------

/** A move is legal if `from` holds the player's piece and `to` is an empty,
 *  adjacent cell that is inward or on the same ring. */
export function isLegalMove(s: AgonState, player: PlayerId, m: AgonMove): boolean {
  if (!Number.isInteger(m.from) || m.from < 0 || m.from >= N) return false;
  if (!Number.isInteger(m.to) || m.to < 0 || m.to >= N) return false;
  if (ownerOf(s.board[m.from]) !== player) return false;
  if (s.board[m.to] !== "") return false;
  if (!NEIGHBORS[m.from].includes(m.to)) return false;
  return RING[m.to] <= RING[m.from];
}

export function legalMoves(s: AgonState, player: PlayerId): AgonMove[] {
  const out: AgonMove[] = [];
  for (let from = 0; from < N; from++) {
    if (ownerOf(s.board[from]) !== player) continue;
    for (const to of NEIGHBORS[from]) {
      if (to < 0) continue;
      if (s.board[to] !== "") continue;
      if (RING[to] <= RING[from]) out.push({ from, to });
    }
  }
  return out;
}

export function hasLegalMove(s: AgonState, player: PlayerId): boolean {
  for (let from = 0; from < N; from++) {
    if (ownerOf(s.board[from]) !== player) continue;
    for (const to of NEIGHBORS[from]) {
      if (to >= 0 && s.board[to] === "" && RING[to] <= RING[from]) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Apply (with custodial flank)
// ---------------------------------------------------------------------------

/**
 * Apply a validated move. Returns the next state. The piece moves, then we
 * resolve flanks created by the moved piece: a flanked enemy Guard is sent to
 * the lowest-index empty outer-ring cell; a flanked enemy Queen is removed
 * (captured → `checkResult` reports the win).
 */
export function applyMove(s: AgonState, player: PlayerId, m: AgonMove): AgonState {
  if (!isLegalMove(s, player, m)) {
    throw new Error(`illegal agon move ${JSON.stringify(m)}`);
  }
  const next = cloneState(s);
  const piece = next.board[m.from];
  next.board[m.from] = "";
  next.board[m.to] = piece;

  const foe = opposite(player);
  const flanked: number[] = [];
  // For each of the 6 directions from the landing cell, an enemy directly
  // adjacent with a friendly piece on the far side is flanked.
  for (let d = 0; d < 6; d++) {
    const mid = NEIGHBORS[m.to][d];
    if (mid < 0) continue;
    if (ownerOf(next.board[mid]) !== foe) continue;
    const far = NEIGHBORS[mid][d]; // continue in the same direction past the enemy
    if (far < 0) continue;
    if (ownerOf(next.board[far]) !== player) continue; // friendly on the far side
    flanked.push(mid);
  }

  for (const mid of flanked) {
    if (kindOf(next.board[mid]) === "Q") {
      next.board[mid] = ""; // queen captured — checkResult turns this into a win
    } else {
      // Send the guard back to the outer ring (it stays in play).
      next.board[mid] = "";
      const dest = OUTER.find((i) => next.board[i] === "");
      if (dest !== undefined) next.board[dest] = (foe + "G") as Cell;
    }
  }

  next.lastMove = { from: m.from, to: m.to, flanked };
  next.moveCount = s.moveCount + 1;
  next.turn = opposite(player);
  return next;
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

/** True if `player`'s queen is on the centre and all six ring-1 cells hold
 *  that player's guards. */
export function isCenteredAndGuarded(s: AgonState, player: PlayerId): boolean {
  if (s.board[CENTER] !== ((player + "Q") as Cell)) return false;
  const g = (player + "G") as Cell;
  return RING1.every((i) => s.board[i] === g);
}

export function checkResult(s: AgonState): AgonResult {
  // Queen captured = immediate loss for its owner.
  const q0 = queenCell(s, "0");
  const q1 = queenCell(s, "1");
  if (q0 < 0 && q1 < 0) return { status: "draw" }; // can't happen, but be safe
  if (q1 < 0) return { status: "win", winner: "0" };
  if (q0 < 0) return { status: "win", winner: "1" };

  // Queen home and ringed by her guards.
  if (isCenteredAndGuarded(s, "0")) return { status: "win", winner: "0" };
  if (isCenteredAndGuarded(s, "1")) return { status: "win", winner: "1" };

  // Player to move with no legal move loses.
  if (!hasLegalMove(s, s.turn)) return { status: "win", winner: opposite(s.turn) };

  if (s.moveCount >= MAX_MOVES) return { status: "draw" };
  return { status: "ongoing" };
}

// ---------------------------------------------------------------------------
// boardgame.io
// ---------------------------------------------------------------------------

export const game: Game<AgonState> = {
  name: "agon",
  setup: () => startingState(),
  turn: { minMoves: 1, maxMoves: 1 },
  moves: {
    play: ({ G, playerID }, raw: unknown) => {
      if (G.turn !== playerID) return INVALID_MOVE;
      const m = raw as AgonMove;
      if (!m || typeof m !== "object" || !isLegalMove(G, playerID as PlayerId, m)) {
        return INVALID_MOVE;
      }
      const next = applyMove(G, playerID as PlayerId, m);
      G.board = next.board;
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
