/**
 * Santorini — pure rules engine + boardgame.io game definition.
 *
 * 5×5 grid. Each player has 2 builders. The board has heights 0..4 in
 * each cell: 0 = ground, 1/2/3 = building floors, 4 = capping dome.
 *
 * Each turn:
 *   1. MOVE one of your two builders to an adjacent cell (8 neighbours
 *      including diagonals). Climb at most one level up; you may step
 *      down any number of levels. You cannot step onto a dome (level 4)
 *      or onto another builder.
 *   2. BUILD one level on a cell adjacent to the destination cell. You
 *      may build on an empty cell or one already with floors; building
 *      on level 3 turns it into a dome (level 4). You cannot build on
 *      a cell occupied by a builder.
 *
 * Move payload: `{ builder: 0|1, to: {row, col}, build: {row, col} }`.
 *
 * WIN:
 *   - Stepping ONTO a level-3 cell wins the game immediately.
 *   - The OPPONENT WINS if you have no legal (move + build) sequence
 *     this turn — you're trapped.
 *
 * Setup: MVP uses fixed starting positions (no builder-placement phase):
 *   - P0 builders at (0, 1) and (0, 3)
 *   - P1 builders at (4, 1) and (4, 3)
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const SIZE = 5;
export const DOME = 4;

export type PlayerId = "0" | "1";
export interface BuilderPos {
  row: number;
  col: number;
}

export interface SantoriniMove {
  builder: 0 | 1;
  to: { row: number; col: number };
  build: { row: number; col: number };
}

export interface SantoriniState {
  levels: number[]; // length 25
  builders: { "0": [BuilderPos, BuilderPos]; "1": [BuilderPos, BuilderPos] };
  turn: PlayerId;
  lastMove: SantoriniMove | null;
}

export type SantoriniResult =
  | { status: "ongoing" }
  | { status: "win"; winner: PlayerId; reason: "climb" | "stuck" };

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

export function cellIdx(row: number, col: number): number {
  return row * SIZE + col;
}
export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < SIZE && col >= 0 && col < SIZE;
}

const NEIGHBOR_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
];

export function neighbors(row: number, col: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [dr, dc] of NEIGHBOR_DELTAS) {
    const nr = row + dr;
    const nc = col + dc;
    if (inBounds(nr, nc)) out.push([nr, nc]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function startingState(): SantoriniState {
  return {
    levels: Array<number>(SIZE * SIZE).fill(0),
    builders: {
      "0": [{ row: 0, col: 1 }, { row: 0, col: 3 }],
      "1": [{ row: 4, col: 1 }, { row: 4, col: 3 }],
    },
    turn: "0",
    lastMove: null,
  };
}

export function cloneState(s: SantoriniState): SantoriniState {
  return {
    levels: s.levels.slice(),
    builders: {
      "0": [{ ...s.builders["0"][0] }, { ...s.builders["0"][1] }],
      "1": [{ ...s.builders["1"][0] }, { ...s.builders["1"][1] }],
    },
    turn: s.turn,
    lastMove: s.lastMove ? { ...s.lastMove } : null,
  };
}

export function opposite(p: PlayerId): PlayerId {
  return p === "0" ? "1" : "0";
}

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

export function isBuilderAt(state: SantoriniState, row: number, col: number): boolean {
  for (const side of ["0", "1"] as const) {
    for (const b of state.builders[side]) {
      if (b.row === row && b.col === col) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Move legality
// ---------------------------------------------------------------------------

export function canMoveTo(
  state: SantoriniState,
  fromR: number,
  fromC: number,
  toR: number,
  toC: number,
): boolean {
  if (!inBounds(toR, toC)) return false;
  // 8-adjacency
  const dr = Math.abs(toR - fromR);
  const dc = Math.abs(toC - fromC);
  if (dr > 1 || dc > 1 || (dr === 0 && dc === 0)) return false;
  if (state.levels[cellIdx(toR, toC)] === DOME) return false;
  if (isBuilderAt(state, toR, toC)) return false;
  const climb = state.levels[cellIdx(toR, toC)] - state.levels[cellIdx(fromR, fromC)];
  if (climb > 1) return false;
  return true;
}

export function canBuildAt(
  state: SantoriniState,
  fromR: number,
  fromC: number,
  toR: number,
  toC: number,
  excludeBuilder?: { side: PlayerId; idx: 0 | 1 },
): boolean {
  if (!inBounds(toR, toC)) return false;
  const dr = Math.abs(toR - fromR);
  const dc = Math.abs(toC - fromC);
  if (dr > 1 || dc > 1 || (dr === 0 && dc === 0)) return false;
  if (state.levels[cellIdx(toR, toC)] === DOME) return false;
  // The mover is no longer on `from` after they move, so the source isn't
  // considered occupied. We skip the exclude-builder when checking.
  for (const side of ["0", "1"] as const) {
    for (let i = 0; i < 2; i++) {
      if (excludeBuilder && excludeBuilder.side === side && excludeBuilder.idx === i) continue;
      const b = state.builders[side][i];
      if (b.row === toR && b.col === toC) return false;
    }
  }
  return true;
}

export function isLegalMove(state: SantoriniState, move: SantoriniMove): boolean {
  if (move.builder !== 0 && move.builder !== 1) return false;
  const b = state.builders[state.turn][move.builder];
  if (!canMoveTo(state, b.row, b.col, move.to.row, move.to.col)) return false;
  // The mover ends up at `to`; build must be adjacent to `to` and not on
  // another builder. The MOVING builder is now at `to`, not at b — so
  // we exclude its old position from the occupancy check.
  // Construct a probe state where the builder has moved.
  const probe = cloneState(state);
  probe.builders[state.turn][move.builder] = { row: move.to.row, col: move.to.col };
  if (!canBuildAt(probe, move.to.row, move.to.col, move.build.row, move.build.col)) return false;
  return true;
}

export function legalMoves(state: SantoriniState): SantoriniMove[] {
  const out: SantoriniMove[] = [];
  const me = state.turn;
  for (let bi = 0 as 0 | 1; bi <= 1; bi++) {
    const b = state.builders[me][bi];
    for (const [tr, tc] of neighbors(b.row, b.col)) {
      if (!canMoveTo(state, b.row, b.col, tr, tc)) continue;
      const probe = cloneState(state);
      probe.builders[me][bi] = { row: tr, col: tc };
      for (const [br, bc] of neighbors(tr, tc)) {
        if (!canBuildAt(probe, tr, tc, br, bc)) continue;
        out.push({ builder: bi, to: { row: tr, col: tc }, build: { row: br, col: bc } });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export function applyMove(state: SantoriniState, move: SantoriniMove): SantoriniState {
  if (!isLegalMove(state, move)) {
    throw new Error(`illegal santorini move ${JSON.stringify(move)}`);
  }
  const next = cloneState(state);
  const me = state.turn;
  const fromLevel = state.levels[cellIdx(state.builders[me][move.builder].row, state.builders[me][move.builder].col)];
  const toLevel = state.levels[cellIdx(move.to.row, move.to.col)];
  next.builders[me][move.builder] = { row: move.to.row, col: move.to.col };

  // Climb-to-3 wins — short-circuit before the build.
  next.lastMove = { ...move };
  if (toLevel === 3 && fromLevel < 3) {
    // Don't flip turn — keep the winning side as `turn` so checkResult
    // can identify the winner.
    return next;
  }

  // Build phase
  const bi = cellIdx(move.build.row, move.build.col);
  next.levels[bi] = Math.min(DOME, next.levels[bi] + 1);

  next.turn = opposite(me);
  return next;
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

export function checkResult(state: SantoriniState): SantoriniResult {
  // Win-by-climb: did the side whose turn it is NOW just lose because the
  // previous mover stepped onto a level-3?
  // We detect this via lastMove + builder height: if any builder of the
  // side that LAST moved is on a level-3 cell, that side won by climb.
  // Since applyMove keeps `turn` as the climbing side on a win, we can
  // simply check if any builder of `state.turn` stands on a level-3.
  for (const side of ["0", "1"] as const) {
    for (const b of state.builders[side]) {
      if (state.levels[cellIdx(b.row, b.col)] === 3) {
        // Only a win if it was the climber's turn just now. If we apply
        // moves through `applyMove`, that's `state.turn === side`.
        if (state.turn === side) return { status: "win", winner: side, reason: "climb" };
      }
    }
  }
  // Stuck: the side to move has no legal move/build sequence.
  if (legalMoves(state).length === 0) {
    return { status: "win", winner: opposite(state.turn), reason: "stuck" };
  }
  return { status: "ongoing" };
}

// ---------------------------------------------------------------------------
// boardgame.io
// ---------------------------------------------------------------------------

export const game: Game<SantoriniState> = {
  name: "santorini",
  setup: () => startingState(),
  turn: { minMoves: 1, maxMoves: 1 },
  moves: {
    play: ({ G, playerID }, raw: unknown) => {
      if (G.turn !== playerID) return INVALID_MOVE;
      const arg = raw as { builder?: unknown; to?: { row?: unknown; col?: unknown }; build?: { row?: unknown; col?: unknown } };
      const builder = Number(arg.builder);
      if (builder !== 0 && builder !== 1) return INVALID_MOVE;
      if (!arg.to || !arg.build) return INVALID_MOVE;
      const tr = Number(arg.to.row);
      const tc = Number(arg.to.col);
      const br = Number(arg.build.row);
      const bc = Number(arg.build.col);
      if (!Number.isInteger(tr) || !Number.isInteger(tc) || !Number.isInteger(br) || !Number.isInteger(bc)) return INVALID_MOVE;
      const move: SantoriniMove = { builder, to: { row: tr, col: tc }, build: { row: br, col: bc } };
      if (!isLegalMove(G, move)) return INVALID_MOVE;
      const next = applyMove(G, move);
      G.levels = next.levels;
      G.builders = next.builders;
      G.turn = next.turn;
      G.lastMove = next.lastMove;
    },
  },
  endIf: ({ G }) => {
    const r = checkResult(G);
    if (r.status === "win") return { winner: r.winner };
  },
};
