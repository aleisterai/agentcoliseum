/**
 * Battleship system bots.
 *
 * IMPORTANT: a bot may only read ITS OWN fleet (`state.fleet[playerID]`) and
 * the PUBLIC shot grids (`state.shots`). Peeking at the opponent's fleet
 * would be cheating — every bot below fires using only its own shot history.
 *
 *   easy   → random valid placement; random open target.
 *   medium → random valid placement; hunt/target — once a hit lands, fire its
 *            un-fired orthogonal neighbours before resuming the random hunt.
 *   hard   → spread-out placement; parity hunt (checkerboard — a length-2
 *            ship must touch a parity cell) + line-extending target mode.
 *
 * Determinism is not required: like the other system bots, the move a bot
 * returns is recorded and replays re-apply the recorded move. Placement uses
 * Math.random for variety.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  BOARD,
  CELLS,
  FLEET_SPEC,
  colOf,
  idx,
  isFireLegal,
  openTargets,
  placementCells,
  rowOf,
  type BattleshipMove,
  type BattleshipState,
  type Orientation,
  type PlayerId,
  type ShipPlacement,
} from "./game";

function randInt(n: number): number {
  return Math.floor(Math.random() * n);
}

function orthoNeighbors(i: number): number[] {
  const r = rowOf(i);
  const c = colOf(i);
  const out: number[] = [];
  if (r > 0) out.push(idx(r - 1, c));
  if (r < BOARD - 1) out.push(idx(r + 1, c));
  if (c > 0) out.push(idx(r, c - 1));
  if (c < BOARD - 1) out.push(idx(r, c + 1));
  return out;
}

/**
 * Build a random valid fleet, largest ship first. Greedy random placement
 * always succeeds for the standard fleet on a 10×10 board. `spread` biases
 * toward positions that don't touch already-placed ships (used by hard).
 */
export function randomFleet(spread = false): ShipPlacement[] {
  // Largest first → easiest to place without backtracking.
  const order = FLEET_SPEC.map((s) => s.length).slice().sort((a, b) => b - a);
  const occupied = new Set<number>();
  const adjacent = new Set<number>();
  const placements: ShipPlacement[] = [];

  for (const length of order) {
    const candidates: ShipPlacement[] = [];
    for (let row = 0; row < BOARD; row++) {
      for (let col = 0; col < BOARD; col++) {
        for (const orientation of ["h", "v"] as Orientation[]) {
          const cells = placementCells({ length, row, col, orientation });
          if (!cells) continue;
          if (cells.some((c) => occupied.has(c))) continue;
          candidates.push({ length, row, col, orientation });
        }
      }
    }
    // candidates is always non-empty for a standard fleet.
    let pool = candidates;
    if (spread) {
      const loose = candidates.filter((p) => {
        const cells = placementCells(p)!;
        return !cells.some((c) => adjacent.has(c));
      });
      if (loose.length > 0) pool = loose;
    }
    const chosen = pool[randInt(pool.length)];
    const cells = placementCells(chosen)!;
    for (const c of cells) {
      occupied.add(c);
      for (const n of orthoNeighbors(c)) adjacent.add(n);
    }
    placements.push(chosen);
  }
  return placements;
}

/** Un-fired orthogonal neighbours of every hit cell (target frontier). */
function targetFrontier(s: BattleshipState, me: PlayerId): number[] {
  const shots = s.shots[me];
  const frontier = new Set<number>();
  for (let i = 0; i < CELLS; i++) {
    if (shots[i] !== "hit") continue;
    for (const n of orthoNeighbors(i)) if (shots[n] === "") frontier.add(n);
  }
  return [...frontier];
}

/**
 * Among hit cells, find collinear adjacent pairs and return their un-fired
 * extension cells (the smart "extend the line" targets). Empty if no line
 * has formed yet.
 */
function lineExtensions(s: BattleshipState, me: PlayerId): number[] {
  const shots = s.shots[me];
  const out = new Set<number>();
  for (let i = 0; i < CELLS; i++) {
    if (shots[i] !== "hit") continue;
    const r = rowOf(i);
    const c = colOf(i);
    // horizontal neighbour hit → extend left/right
    if (c + 1 < BOARD && shots[idx(r, c + 1)] === "hit") {
      if (c - 1 >= 0 && shots[idx(r, c - 1)] === "") out.add(idx(r, c - 1));
      if (c + 2 < BOARD && shots[idx(r, c + 2)] === "") out.add(idx(r, c + 2));
    }
    // vertical neighbour hit → extend up/down
    if (r + 1 < BOARD && shots[idx(r + 1, c)] === "hit") {
      if (r - 1 >= 0 && shots[idx(r - 1, c)] === "") out.add(idx(r - 1, c));
      if (r + 2 < BOARD && shots[idx(r + 2, c)] === "") out.add(idx(r + 2, c));
    }
  }
  return [...out];
}

function fireAt(index: number): BattleshipMove {
  return { kind: "fire", row: rowOf(index), col: colOf(index) };
}

/** Shared fire chooser. `level` tunes the hunt heuristic. */
function chooseFire(
  s: BattleshipState,
  me: PlayerId,
  level: "easy" | "medium" | "hard",
): BattleshipMove {
  const open = openTargets(s, me);
  if (open.length === 0) throw new Error("battleship bot: no open targets");

  if (level !== "easy") {
    if (level === "hard") {
      const lines = lineExtensions(s, me);
      if (lines.length > 0) return fireAt(lines[randInt(lines.length)]);
    }
    const frontier = targetFrontier(s, me);
    if (frontier.length > 0) return fireAt(frontier[randInt(frontier.length)]);
  }

  if (level === "hard") {
    // Parity hunt: a ship of length ≥2 always covers a checkerboard cell,
    // so firing only parity-0 cells in hunt mode halves the search.
    const parity = open.filter((i) => (rowOf(i) + colOf(i)) % 2 === 0);
    if (parity.length > 0) return fireAt(parity[randInt(parity.length)]);
  }
  return fireAt(open[randInt(open.length)]);
}

function makeBot(level: "easy" | "medium" | "hard"): BotStrategy<BattleshipState, BattleshipMove> {
  return {
    pickMove: (state, playerID) => {
      const me: PlayerId = playerID;
      if (state.phase === "placement") {
        if (state.placed[me]) {
          // Shouldn't be asked to move; defensive no-op fleet re-place.
          throw new Error("battleship bot: already placed");
        }
        return { kind: "place", ships: randomFleet(level === "hard") };
      }
      // firing
      const move = chooseFire(state, me, level);
      // Defensive: ensure legality (should always hold).
      if (move.kind === "fire" && !isFireLegal(state, me, move.row, move.col)) {
        const open = openTargets(state, me);
        return fireAt(open[0]);
      }
      return move;
    },
  };
}

export const easyBot = makeBot("easy");
export const mediumBot = makeBot("medium");
export const hardBot = makeBot("hard");
