/**
 * Battleship (2-player, hidden information) — rules engine + boardgame.io game.
 *
 * Two phases on a 10×10 grid (index = row*10 + col, 0..99):
 *
 *   1. PLACEMENT — each player submits their ENTIRE fleet in one move:
 *        { kind: "place", ships: [{ length, row, col, orientation }, …] }
 *      The required fleet is exactly five ships of lengths 5,4,3,3,2
 *      (Carrier, Battleship, Cruiser, Submarine, Destroyer). Ships are
 *      axis-aligned ("h" = rightward, "v" = downward from {row,col}), must
 *      be fully in-bounds, and must not overlap. Ships MAY touch. A fleet
 *      is hidden from the opponent (this is the imperfect-information bit).
 *      Player 0 places, then player 1; once both have placed the game
 *      advances to firing with player 0 on the clock.
 *
 *   2. FIRING — players alternate single shots:
 *        { kind: "fire", row, col }
 *      The engine reports hit/miss and, when a shot completes a ship, which
 *      ship was sunk. You cannot fire at a cell you've already fired at.
 *      First player to sink the opponent's whole fleet (all 17 cells) wins.
 *      There is NO extra turn on a hit — strict alternation, like the
 *      pencil-and-paper game.
 *
 * Determinism: there is no randomness anywhere — placement is player-chosen
 * and firing is a pure function of the move + hidden fleet. Replays are
 * therefore exact without a seed. The only "hidden" aspect is redaction in
 * `serializeForSpectator` (see index.ts).
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const BOARD = 10;
export const CELLS = BOARD * BOARD; // 100

/** Canonical fleet: name + length. Order matters for `place` assignment. */
export const FLEET_SPEC: ReadonlyArray<{ name: string; length: number }> = [
  { name: "Carrier", length: 5 },
  { name: "Battleship", length: 4 },
  { name: "Cruiser", length: 3 },
  { name: "Submarine", length: 3 },
  { name: "Destroyer", length: 2 },
];

/** Sorted multiset of required ship lengths, e.g. [2,3,3,4,5]. */
export const REQUIRED_LENGTHS: number[] = FLEET_SPEC.map((s) => s.length)
  .slice()
  .sort((a, b) => a - b);

/** Total occupied cells across a full fleet (17). Win = all of these hit. */
export const TOTAL_SHIP_CELLS = FLEET_SPEC.reduce((n, s) => n + s.length, 0);

export type PlayerId = "0" | "1";
export type Orientation = "h" | "v";
export type ShotResult = "" | "hit" | "miss"; // "" = not fired at

export interface Ship {
  name: string;
  length: number;
  cells: number[]; // board indices, ascending
}

export interface ShipPlacement {
  length: number;
  row: number;
  col: number;
  orientation: Orientation;
}

export type BattleshipMove =
  | { kind: "place"; ships: ShipPlacement[] }
  | { kind: "fire"; row: number; col: number };

export interface LastShot {
  by: PlayerId;
  index: number;
  result: "hit" | "miss";
  /** Ship name if this shot sank a ship, else null. */
  sunk: string | null;
}

export interface BattleshipState {
  /** Each player's own fleet — HIDDEN from the opponent until game over. */
  fleet: { "0": Ship[]; "1": Ship[] };
  placed: { "0": boolean; "1": boolean };
  /**
   * Shots fired BY a player at the opponent's grid, length-100 each.
   * "" = not fired, "hit" | "miss" otherwise. PUBLIC — both players (and
   * spectators) know the full shot history; only un-hit ship cells are
   * secret.
   */
  shots: { "0": ShotResult[]; "1": ShotResult[] };
  phase: "placement" | "firing";
  turn: PlayerId;
  lastMove: BattleshipMove | null;
  lastShot: LastShot | null;
}

export type BattleshipResult =
  | { status: "ongoing" }
  | { status: "win"; winner: PlayerId };

export function opposite(p: PlayerId): PlayerId {
  return p === "0" ? "1" : "0";
}

export function idx(row: number, col: number): number {
  return row * BOARD + col;
}

export function rowOf(index: number): number {
  return Math.floor(index / BOARD);
}

export function colOf(index: number): number {
  return index % BOARD;
}

function emptyShots(): ShotResult[] {
  return new Array<ShotResult>(CELLS).fill("");
}

export function startingState(): BattleshipState {
  return {
    fleet: { "0": [], "1": [] },
    placed: { "0": false, "1": false },
    shots: { "0": emptyShots(), "1": emptyShots() },
    phase: "placement",
    turn: "0",
    lastMove: null,
    lastShot: null,
  };
}

export function cloneState(s: BattleshipState): BattleshipState {
  return {
    fleet: {
      "0": s.fleet["0"].map((sh) => ({ ...sh, cells: sh.cells.slice() })),
      "1": s.fleet["1"].map((sh) => ({ ...sh, cells: sh.cells.slice() })),
    },
    placed: { ...s.placed },
    shots: { "0": s.shots["0"].slice(), "1": s.shots["1"].slice() },
    phase: s.phase,
    turn: s.turn,
    lastMove: s.lastMove
      ? s.lastMove.kind === "place"
        ? { kind: "place", ships: s.lastMove.ships.map((p) => ({ ...p })) }
        : { ...s.lastMove }
      : null,
    lastShot: s.lastShot ? { ...s.lastShot } : null,
  };
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Compute the occupied cells of a single placement, or null if off-board. */
export function placementCells(p: ShipPlacement): number[] | null {
  if (!Number.isInteger(p.row) || !Number.isInteger(p.col)) return null;
  if (!Number.isInteger(p.length) || p.length < 1) return null;
  if (p.orientation !== "h" && p.orientation !== "v") return null;
  if (p.row < 0 || p.row >= BOARD || p.col < 0 || p.col >= BOARD) return null;
  const cells: number[] = [];
  for (let k = 0; k < p.length; k++) {
    const r = p.orientation === "v" ? p.row + k : p.row;
    const c = p.orientation === "h" ? p.col + k : p.col;
    if (r >= BOARD || c >= BOARD) return null; // ran off the edge
    cells.push(idx(r, c));
  }
  return cells;
}

export interface FleetBuild {
  ok: boolean;
  fleet?: Ship[];
  error?: string;
}

/**
 * Validate a set of placements and build the named fleet. Checks:
 *   - exactly 5 ships,
 *   - lengths are the required multiset [2,3,3,4,5],
 *   - every ship in bounds,
 *   - no two ships overlap (touching is allowed).
 * Names are assigned by matching each placement to a FLEET_SPEC slot of the
 * same length (the two length-3 ships become Cruiser then Submarine).
 */
export function buildFleet(placements: ShipPlacement[]): FleetBuild {
  if (!Array.isArray(placements)) return { ok: false, error: "ships must be an array" };
  if (placements.length !== FLEET_SPEC.length) {
    return { ok: false, error: `must place exactly ${FLEET_SPEC.length} ships` };
  }
  const lengths = placements.map((p) => p.length).slice().sort((a, b) => a - b);
  if (lengths.join(",") !== REQUIRED_LENGTHS.join(",")) {
    return {
      ok: false,
      error: `ship lengths must be ${REQUIRED_LENGTHS.join(",")} (got ${lengths.join(",")})`,
    };
  }

  // Match each placement to a name slot by length (stable, by spec order).
  const remaining = FLEET_SPEC.map((s) => ({ ...s, used: false }));
  const occupied = new Set<number>();
  const fleet: Ship[] = [];
  for (const p of placements) {
    const cells = placementCells(p);
    if (cells === null) {
      return { ok: false, error: `ship at (${p.row},${p.col}) is off-board or malformed` };
    }
    for (const c of cells) {
      if (occupied.has(c)) {
        return { ok: false, error: `ships overlap at cell ${c}` };
      }
    }
    const slot = remaining.find((s) => !s.used && s.length === p.length);
    if (!slot) {
      return { ok: false, error: `unexpected ship of length ${p.length}` };
    }
    slot.used = true;
    for (const c of cells) occupied.add(c);
    fleet.push({ name: slot.name, length: p.length, cells: cells.slice().sort((a, b) => a - b) });
  }
  return { ok: true, fleet };
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

/** The ship occupying `cell`, or null. */
export function shipAt(fleet: Ship[], cell: number): Ship | null {
  for (const sh of fleet) if (sh.cells.includes(cell)) return sh;
  return null;
}

/** True if every cell of `ship` has been hit in `shots`. */
export function shipSunk(ship: Ship, shots: ShotResult[]): boolean {
  return ship.cells.every((c) => shots[c] === "hit");
}

/** True if `fireBy` (shots at this fleet) have sunk every ship. */
export function fleetDestroyed(fleet: Ship[], shots: ShotResult[]): boolean {
  if (fleet.length === 0) return false;
  return fleet.every((sh) => shipSunk(sh, shots));
}

export function isFireLegal(
  s: BattleshipState,
  by: PlayerId,
  row: number,
  col: number,
): boolean {
  if (s.phase !== "firing") return false;
  if (s.turn !== by) return false;
  if (!Number.isInteger(row) || !Number.isInteger(col)) return false;
  if (row < 0 || row >= BOARD || col < 0 || col >= BOARD) return false;
  return s.shots[by][idx(row, col)] === ""; // not already fired here
}

/** Cells the player has NOT yet fired at (legal fire targets). */
export function openTargets(s: BattleshipState, by: PlayerId): number[] {
  const out: number[] = [];
  for (let i = 0; i < CELLS; i++) if (s.shots[by][i] === "") out.push(i);
  return out;
}

export function checkResult(s: BattleshipState): BattleshipResult {
  if (s.phase !== "firing") return { status: "ongoing" };
  // A player wins by destroying the OPPONENT's fleet with THEIR OWN shots.
  if (fleetDestroyed(s.fleet["1"], s.shots["0"])) return { status: "win", winner: "0" };
  if (fleetDestroyed(s.fleet["0"], s.shots["1"])) return { status: "win", winner: "1" };
  return { status: "ongoing" };
}

// ---------------------------------------------------------------------------
// boardgame.io
// ---------------------------------------------------------------------------

function asPlacements(raw: unknown): ShipPlacement[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "place") return null;
  if (!Array.isArray(r.ships)) return null;
  const out: ShipPlacement[] = [];
  for (const item of r.ships) {
    if (typeof item !== "object" || item === null) return null;
    const o = item as Record<string, unknown>;
    const length = Number(o.length);
    const row = Number(o.row);
    const col = Number(o.col);
    const orientation = o.orientation;
    if (orientation !== "h" && orientation !== "v") return null;
    if (!Number.isInteger(length) || !Number.isInteger(row) || !Number.isInteger(col)) {
      return null;
    }
    out.push({ length, row, col, orientation });
  }
  return out;
}

export const game: Game<BattleshipState> = {
  name: "battleship",
  setup: () => startingState(),
  turn: {
    minMoves: 1,
    maxMoves: 1,
    // Turn order is fully driven by G.turn (placement order, then strict
    // firing alternation), so read it directly.
    order: {
      first: () => 0,
      next: ({ G }) => Number(G.turn),
    },
  },
  moves: {
    place: ({ G, playerID }, raw: unknown) => {
      const me = playerID as PlayerId;
      if (G.phase !== "placement") return INVALID_MOVE;
      if (G.turn !== me) return INVALID_MOVE;
      if (G.placed[me]) return INVALID_MOVE;
      const placements = asPlacements(raw);
      if (placements === null) return INVALID_MOVE;
      const built = buildFleet(placements);
      if (!built.ok || !built.fleet) return INVALID_MOVE;
      G.fleet[me] = built.fleet;
      G.placed[me] = true;
      G.lastMove = { kind: "place", ships: placements.map((p) => ({ ...p })) };
      if (G.placed["0"] && G.placed["1"]) {
        G.phase = "firing";
        G.turn = "0";
      } else {
        G.turn = opposite(me);
      }
    },
    fire: ({ G, playerID }, raw: unknown) => {
      const me = playerID as PlayerId;
      if (G.phase !== "firing") return INVALID_MOVE;
      if (G.turn !== me) return INVALID_MOVE;
      const arg = raw as { row?: unknown; col?: unknown };
      const row = Number(arg?.row);
      const col = Number(arg?.col);
      if (!isFireLegal(G, me, row, col)) return INVALID_MOVE;
      const i = idx(row, col);
      const opp = opposite(me);
      const target = shipAt(G.fleet[opp], i);
      const hit = target !== null;
      G.shots[me][i] = hit ? "hit" : "miss";
      let sunk: string | null = null;
      if (target && shipSunk(target, G.shots[me])) sunk = target.name;
      G.lastShot = { by: me, index: i, result: hit ? "hit" : "miss", sunk };
      G.lastMove = { kind: "fire", row, col };
      G.turn = opposite(me); // strict alternation, even on a hit
    },
  },
  endIf: ({ G }) => {
    const r = checkResult(G);
    if (r.status === "win") return { winner: r.winner };
  },
};
