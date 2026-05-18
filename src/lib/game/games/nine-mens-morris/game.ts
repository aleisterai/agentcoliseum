/**
 * Nine Men's Morris — pure rules engine + boardgame.io game definition.
 *
 * 24 points arranged in three concentric squares:
 *
 *    0 ─────── 1 ─────── 2
 *    │         │         │
 *    │  3 ──── 4 ──── 5  │
 *    │  │      │      │  │
 *    │  │  6 ─ 7 ─ 8  │  │
 *    │  │  │       │  │  │
 *    9 ─10─11      12─13─14
 *    │  │  │       │  │  │
 *    │  │  15─16─17  │  │
 *    │  │      │      │  │
 *    │ 18 ─── 19 ──── 20 │
 *    │         │         │
 *   21 ────── 22 ────── 23
 *
 * Each player has 9 pieces. The game has three phases:
 *
 *   1. PLACEMENT — players alternate placing pieces on empty points.
 *   2. MOVEMENT  — once all 18 pieces are placed, players alternate
 *                  moving one of their pieces to an adjacent empty point.
 *   3. FLYING    — when a player drops to exactly 3 pieces, they may
 *                  move any of their pieces to ANY empty point (not just
 *                  adjacent).
 *
 * Forming a "mill" (3 pieces in a row along a board line) entitles the
 * moving player to REMOVE one of the opponent's pieces. You may not
 * remove a piece that is part of an opponent mill UNLESS all of the
 * opponent's pieces are in mills.
 *
 * Win: opponent reduced to fewer than 3 pieces, OR opponent has no
 * legal moves (and is not flying).
 *
 * Move shapes:
 *   - Placement: { from: null, to: <0..23>,  remove?: <0..23> }
 *   - Movement:  { from: <0..23>, to: <0..23>, remove?: <0..23> }
 *
 * The optional `remove` field is REQUIRED when the play would form a
 * mill; the server validates this. If no mill is formed, `remove` must
 * be absent.
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const NUM_POINTS = 24;
export const TOTAL_PIECES_PER_SIDE = 9;
export const MIN_PIECES_FOR_FLYING = 3;

export type PlayerId = "0" | "1";
export type Point = "" | PlayerId;

export interface NMMMove {
  from: number | null;
  to: number;
  remove?: number;
}

export interface NMMState {
  points: Point[]; // length 24
  turn: PlayerId;
  /** "placement" until both players have placed all 9; then "movement". */
  phase: "placement" | "movement";
  /** Number placed so far per player (max 9 each). */
  placed: { "0": number; "1": number };
  /** Number remaining on the board per player (decremented by removals). */
  alive: { "0": number; "1": number };
  lastMove: NMMMove | null;
}

export type NMMResult =
  | { status: "ongoing" }
  | { status: "win"; winner: PlayerId; reason: "few_pieces" | "no_moves" };

// ---------------------------------------------------------------------------
// Board topology: adjacency and mill lines
// ---------------------------------------------------------------------------

/**
 * Adjacency table — for each point, the list of points reachable by
 * sliding along a board line (one step). Used in the MOVEMENT phase to
 * validate non-flying moves.
 */
export const ADJACENCY: ReadonlyArray<ReadonlyArray<number>> = [
  /*  0 */ [1, 9],
  /*  1 */ [0, 2, 4],
  /*  2 */ [1, 14],
  /*  3 */ [4, 10],
  /*  4 */ [1, 3, 5, 7],
  /*  5 */ [4, 13],
  /*  6 */ [7, 11],
  /*  7 */ [4, 6, 8],
  /*  8 */ [7, 12],
  /*  9 */ [0, 10, 21],
  /* 10 */ [3, 9, 11, 18],
  /* 11 */ [6, 10, 15],
  /* 12 */ [8, 13, 17],
  /* 13 */ [5, 12, 14, 20],
  /* 14 */ [2, 13, 23],
  /* 15 */ [11, 16],
  /* 16 */ [15, 17, 19],
  /* 17 */ [12, 16],
  /* 18 */ [10, 19],
  /* 19 */ [16, 18, 20, 22],
  /* 20 */ [13, 19],
  /* 21 */ [9, 22],
  /* 22 */ [19, 21, 23],
  /* 23 */ [14, 22],
];

/**
 * All 16 possible mills (lines of 3 points). Generated from the board's
 * 8 horizontal lines (one per ring corner / ring center row) and 8
 * vertical lines.
 */
export const MILLS: ReadonlyArray<readonly [number, number, number]> = [
  // Horizontal
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [9, 10, 11],
  [12, 13, 14],
  [15, 16, 17],
  [18, 19, 20],
  [21, 22, 23],
  // Vertical
  [0, 9, 21],
  [3, 10, 18],
  [6, 11, 15],
  [1, 4, 7],
  [16, 19, 22],
  [8, 12, 17],
  [5, 13, 20],
  [2, 14, 23],
];

/** Pre-indexed: which mills include each point. Faster mill checks. */
const MILLS_BY_POINT: ReadonlyArray<ReadonlyArray<number>> = (() => {
  const out: number[][] = Array.from({ length: NUM_POINTS }, () => []);
  MILLS.forEach((mill, mIdx) => {
    for (const p of mill) out[p].push(mIdx);
  });
  return out;
})();

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function startingState(): NMMState {
  return {
    points: Array<Point>(NUM_POINTS).fill(""),
    turn: "0",
    phase: "placement",
    placed: { "0": 0, "1": 0 },
    alive: { "0": 0, "1": 0 },
    lastMove: null,
  };
}

export function cloneState(s: NMMState): NMMState {
  return {
    points: s.points.slice() as Point[],
    turn: s.turn,
    phase: s.phase,
    placed: { ...s.placed },
    alive: { ...s.alive },
    lastMove: s.lastMove ? { ...s.lastMove } : null,
  };
}

export function opposite(p: PlayerId): PlayerId {
  return p === "0" ? "1" : "0";
}

// ---------------------------------------------------------------------------
// Mill detection
// ---------------------------------------------------------------------------

/** True if point `p` is part of an active mill for `side` in `points`. */
export function isInMill(points: Point[], p: number, side: PlayerId): boolean {
  for (const mIdx of MILLS_BY_POINT[p]) {
    const [a, b, c] = MILLS[mIdx];
    if (points[a] === side && points[b] === side && points[c] === side) return true;
  }
  return false;
}

/**
 * Would placing/moving `side` to point `to` (with origin `from` cleared
 * first, if applicable) create a NEW mill? Used to determine whether the
 * `remove` field should be required on this move.
 */
function wouldFormMill(points: Point[], from: number | null, to: number, side: PlayerId): boolean {
  const test = points.slice() as Point[];
  if (from !== null) test[from] = "";
  test[to] = side;
  return isInMill(test, to, side);
}

// ---------------------------------------------------------------------------
// Removal legality
// ---------------------------------------------------------------------------

/**
 * Returns true if `side` can remove the opponent's piece at `target`.
 * Standard rule: cannot remove a piece in a mill UNLESS all of the
 * opponent's pieces are in mills.
 */
export function canRemove(state: NMMState, target: number, side: PlayerId): boolean {
  const opp = opposite(side);
  if (target < 0 || target >= NUM_POINTS) return false;
  if (state.points[target] !== opp) return false;
  // If target isn't in a mill, fine.
  if (!isInMill(state.points, target, opp)) return true;
  // Target IS in a mill — only allowed if ALL opponent pieces are in mills.
  for (let i = 0; i < NUM_POINTS; i++) {
    if (state.points[i] === opp && !isInMill(state.points, i, opp)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Move legality + enumeration
// ---------------------------------------------------------------------------

/** True if `side` can move (any piece) given the current state. */
function canPlayerMove(state: NMMState, side: PlayerId): boolean {
  if (state.phase === "placement") return state.placed[side] < TOTAL_PIECES_PER_SIDE;
  // Movement / flying: at least one own piece has at least one legal target.
  const flying = state.alive[side] === MIN_PIECES_FOR_FLYING;
  for (let i = 0; i < NUM_POINTS; i++) {
    if (state.points[i] !== side) continue;
    if (flying) {
      for (let j = 0; j < NUM_POINTS; j++) if (state.points[j] === "") return true;
      return false;
    }
    for (const j of ADJACENCY[i]) if (state.points[j] === "") return true;
  }
  return false;
}

/**
 * Returns true if `move` is legal in `state` for the current side, NOT
 * including the `remove` validation. The caller validates `remove` after
 * confirming the play creates a mill.
 */
export function isLegalPlay(state: NMMState, move: NMMMove): boolean {
  const side = state.turn;
  if (move.to < 0 || move.to >= NUM_POINTS) return false;
  if (state.points[move.to] !== "") return false;
  if (state.phase === "placement") {
    if (move.from !== null) return false;
    return state.placed[side] < TOTAL_PIECES_PER_SIDE;
  }
  // Movement phase
  if (move.from === null) return false;
  if (move.from < 0 || move.from >= NUM_POINTS) return false;
  if (state.points[move.from] !== side) return false;
  const flying = state.alive[side] === MIN_PIECES_FOR_FLYING;
  if (flying) return true; // any empty target ok
  return ADJACENCY[move.from].includes(move.to);
}

/**
 * Enumerates every legal { from, to } play in the current state. Removal
 * choice (when a mill is formed) is enumerated separately by
 * `legalRemovals`.
 */
export function legalPlays(state: NMMState): Array<{ from: number | null; to: number }> {
  const out: Array<{ from: number | null; to: number }> = [];
  const side = state.turn;
  if (state.phase === "placement") {
    if (state.placed[side] >= TOTAL_PIECES_PER_SIDE) return out;
    for (let i = 0; i < NUM_POINTS; i++) {
      if (state.points[i] === "") out.push({ from: null, to: i });
    }
    return out;
  }
  const flying = state.alive[side] === MIN_PIECES_FOR_FLYING;
  for (let i = 0; i < NUM_POINTS; i++) {
    if (state.points[i] !== side) continue;
    if (flying) {
      for (let j = 0; j < NUM_POINTS; j++) {
        if (state.points[j] === "") out.push({ from: i, to: j });
      }
    } else {
      for (const j of ADJACENCY[i]) {
        if (state.points[j] === "") out.push({ from: i, to: j });
      }
    }
  }
  return out;
}

/** Targets the moving player can remove (after forming a mill). */
export function legalRemovals(state: NMMState): number[] {
  const me = state.turn;
  const out: number[] = [];
  for (let i = 0; i < NUM_POINTS; i++) {
    if (canRemove(state, i, me)) out.push(i);
  }
  return out;
}

/**
 * Enumerate every full legal MOVE (including any required removal). When
 * a play forms a mill, returns one variant per legal removal choice. When
 * it doesn't, returns a single variant with no `remove` field.
 */
export function legalMoves(state: NMMState): NMMMove[] {
  const out: NMMMove[] = [];
  const side = state.turn;
  for (const play of legalPlays(state)) {
    const formsMill = wouldFormMill(state.points, play.from, play.to, side);
    if (!formsMill) {
      out.push({ from: play.from, to: play.to });
      continue;
    }
    // Apply the play to a probe state, then enumerate legal removals
    // from THAT state — removals may differ depending on which piece
    // moved (other mills may break).
    const probe = applyPlayOnly(state, play);
    for (const t of legalRemovals(probe)) {
      out.push({ from: play.from, to: play.to, remove: t });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Apply move
// ---------------------------------------------------------------------------

/** Apply only the from/to part, without removal. Used by mill-formation probe. */
function applyPlayOnly(state: NMMState, play: { from: number | null; to: number }): NMMState {
  const next = cloneState(state);
  const me = state.turn;
  if (play.from !== null) {
    next.points[play.from] = "";
  }
  next.points[play.to] = me;
  if (state.phase === "placement") {
    next.placed[me] += 1;
    next.alive[me] += 1;
  }
  return next;
}

export function applyMove(state: NMMState, move: NMMMove): NMMState {
  if (!isLegalPlay(state, move)) {
    throw new Error(`illegal play (from=${move.from}, to=${move.to})`);
  }
  const me = state.turn;
  const opp = opposite(me);

  const afterPlay = applyPlayOnly(state, { from: move.from, to: move.to });
  const formsMill = isInMill(afterPlay.points, move.to, me);

  if (formsMill) {
    if (typeof move.remove !== "number") {
      throw new Error("forming a mill requires a `remove` target");
    }
    if (!canRemove(afterPlay, move.remove, me)) {
      throw new Error(`illegal removal at ${move.remove}`);
    }
    afterPlay.points[move.remove] = "";
    afterPlay.alive[opp] -= 1;
  } else if (typeof move.remove === "number") {
    throw new Error("move does not form a mill — `remove` not allowed");
  }

  // Phase transition: if both players have placed 9 → enter movement.
  if (afterPlay.phase === "placement" && afterPlay.placed["0"] === TOTAL_PIECES_PER_SIDE && afterPlay.placed["1"] === TOTAL_PIECES_PER_SIDE) {
    afterPlay.phase = "movement";
  }

  afterPlay.turn = opp;
  afterPlay.lastMove = { from: move.from, to: move.to, ...(typeof move.remove === "number" ? { remove: move.remove } : {}) };
  return afterPlay;
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

export function checkResult(state: NMMState): NMMResult {
  // In placement phase, you can't lose by pieces — only by being unable
  // to move. But during placement, all empty points are legal so this
  // never triggers.
  if (state.phase === "movement") {
    for (const side of ["0", "1"] as const) {
      if (state.alive[side] < MIN_PIECES_FOR_FLYING) {
        return { status: "win", winner: opposite(side), reason: "few_pieces" };
      }
    }
  }
  if (!canPlayerMove(state, state.turn)) {
    return { status: "win", winner: opposite(state.turn), reason: "no_moves" };
  }
  return { status: "ongoing" };
}

// ---------------------------------------------------------------------------
// boardgame.io Game definition
// ---------------------------------------------------------------------------

export const game: Game<NMMState> = {
  name: "nine-mens-morris",
  setup: () => startingState(),
  turn: { minMoves: 1, maxMoves: 1 },
  moves: {
    play: ({ G, playerID }, raw: unknown) => {
      if (G.turn !== playerID) return INVALID_MOVE;
      const arg = raw as { from?: unknown; to?: unknown; remove?: unknown };
      const from = arg.from === null ? null : Number(arg.from);
      const to = Number(arg.to);
      if (!Number.isInteger(to)) return INVALID_MOVE;
      if (from !== null && !Number.isInteger(from)) return INVALID_MOVE;
      const move: NMMMove = { from, to };
      if (typeof arg.remove === "number" && Number.isInteger(arg.remove)) {
        move.remove = arg.remove;
      }
      // Validate play, then mill-formation + removal coherence.
      if (!isLegalPlay(G, move)) return INVALID_MOVE;
      const probe = applyPlayOnly(G, { from: move.from, to: move.to });
      const formsMill = isInMill(probe.points, move.to, G.turn);
      if (formsMill) {
        if (typeof move.remove !== "number") return INVALID_MOVE;
        if (!canRemove(probe, move.remove, G.turn)) return INVALID_MOVE;
      } else if (typeof move.remove === "number") {
        return INVALID_MOVE;
      }
      const next = applyMove(G, move);
      G.points = next.points;
      G.turn = next.turn;
      G.phase = next.phase;
      G.placed = next.placed;
      G.alive = next.alive;
      G.lastMove = next.lastMove;
    },
  },
  endIf: ({ G }) => {
    const r = checkResult(G);
    if (r.status === "win") return { winner: r.winner };
  },
};
