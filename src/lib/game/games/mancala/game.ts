/**
 * Mancala (Kalah variant) — pure rules engine + boardgame.io game.
 *
 * 14 pits in a flat array:
 *
 *   indices 0..5   = Player 0's six pits (left to right from P0's view)
 *   index 6        = Player 0's STORE (mancala)
 *   indices 7..12  = Player 1's six pits (left to right from P1's view)
 *   index 13       = Player 1's STORE
 *
 * Each player starts with 4 seeds in each of their 6 pits (24 per side,
 * 48 total). Stores start empty.
 *
 * Move: pick one of your non-empty pits. Sow the seeds one-by-one,
 * counter-clockwise (in array order modulo 14), SKIPPING the opponent's
 * store. If the last seed:
 *   - lands in YOUR store           → take another turn
 *   - lands in an EMPTY pit on YOUR side AND the pit directly across
 *     (opponent's) has seeds         → capture both into your store
 *
 * Game ends when one side has empty pits. The other side moves all their
 * remaining seeds into their own store. Winner = more seeds in store.
 *
 * Move payload: `{ pit: number }` — must own and be non-empty.
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const PITS_PER_SIDE = 6;
export const TOTAL_PITS = (PITS_PER_SIDE + 1) * 2; // 14
export const STORE_0 = PITS_PER_SIDE;      // 6
export const STORE_1 = TOTAL_PITS - 1;     // 13
export const SEEDS_PER_PIT = 4;
export const TOTAL_SEEDS = PITS_PER_SIDE * SEEDS_PER_PIT * 2;

export type PlayerId = "0" | "1";

export interface MancalaMove {
  pit: number; // 0..5 for P0, 7..12 for P1
}

export interface MancalaState {
  pits: number[]; // length TOTAL_PITS
  turn: PlayerId;
  lastMove: { pit: number; landed: number; captured: number } | null;
}

export type MancalaResult =
  | { status: "ongoing" }
  | { status: "win"; winner: PlayerId; stores: { "0": number; "1": number } }
  | { status: "draw"; stores: { "0": number; "1": number } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function startingState(): MancalaState {
  const pits = Array<number>(TOTAL_PITS).fill(0);
  for (let i = 0; i < PITS_PER_SIDE; i++) pits[i] = SEEDS_PER_PIT;
  for (let i = PITS_PER_SIDE + 1; i < STORE_1; i++) pits[i] = SEEDS_PER_PIT;
  return { pits, turn: "0", lastMove: null };
}

export function cloneState(s: MancalaState): MancalaState {
  return {
    pits: s.pits.slice(),
    turn: s.turn,
    lastMove: s.lastMove ? { ...s.lastMove } : null,
  };
}

export function opposite(p: PlayerId): PlayerId {
  return p === "0" ? "1" : "0";
}

/** Returns true if `pit` belongs to `player` (i.e. is one of their six pits). */
export function ownsPit(pit: number, player: PlayerId): boolean {
  if (!Number.isInteger(pit)) return false;
  if (player === "0") return pit >= 0 && pit < PITS_PER_SIDE;
  return pit > STORE_0 && pit < STORE_1;
}

/** Store index for `player`. */
export function storeOf(player: PlayerId): number {
  return player === "0" ? STORE_0 : STORE_1;
}

/** Opponent's store — the one to SKIP during sowing. */
export function opponentStoreOf(player: PlayerId): number {
  return player === "0" ? STORE_1 : STORE_0;
}

/**
 * The pit directly OPPOSITE `pit` on the board (used for captures).
 * P0's pit 0 ↔ P1's pit 12; pit 1 ↔ 11; … pit 5 ↔ 7.
 */
export function oppositePit(pit: number): number {
  // The two stores have no opposite.
  if (pit === STORE_0 || pit === STORE_1) return -1;
  return STORE_1 - 1 - pit;
}

// ---------------------------------------------------------------------------
// Move legality
// ---------------------------------------------------------------------------

export function isLegalMove(state: MancalaState, pit: number): boolean {
  if (!ownsPit(pit, state.turn)) return false;
  return state.pits[pit] > 0;
}

export function legalMoves(state: MancalaState): MancalaMove[] {
  const out: MancalaMove[] = [];
  const start = state.turn === "0" ? 0 : PITS_PER_SIDE + 1;
  for (let i = 0; i < PITS_PER_SIDE; i++) {
    const pit = start + i;
    if (state.pits[pit] > 0) out.push({ pit });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Apply move
// ---------------------------------------------------------------------------

export function applyMove(state: MancalaState, move: MancalaMove): MancalaState {
  if (!isLegalMove(state, move.pit)) {
    throw new Error(`illegal mancala move from pit ${move.pit}`);
  }
  const next = cloneState(state);
  const me = state.turn;
  const myStore = storeOf(me);
  const oppStore = opponentStoreOf(me);

  let seeds = next.pits[move.pit];
  next.pits[move.pit] = 0;
  let cursor = move.pit;
  while (seeds > 0) {
    cursor = (cursor + 1) % TOTAL_PITS;
    if (cursor === oppStore) continue; // skip opponent's store
    next.pits[cursor] += 1;
    seeds -= 1;
  }

  let captured = 0;
  // Capture rule: last seed lands in an EMPTY pit on YOUR side AND the
  // pit opposite has seeds.
  if (
    ownsPit(cursor, me) &&
    next.pits[cursor] === 1 &&
    next.pits[oppositePit(cursor)] > 0
  ) {
    const opp = oppositePit(cursor);
    captured = next.pits[cursor] + next.pits[opp];
    next.pits[myStore] += captured;
    next.pits[cursor] = 0;
    next.pits[opp] = 0;
  }

  // Bonus turn if last seed landed in YOUR store.
  const bonusTurn = cursor === myStore;
  if (!bonusTurn) next.turn = opposite(me);

  next.lastMove = { pit: move.pit, landed: cursor, captured };

  // If after this move one side is empty, the other side sweeps the rest.
  endgameSweep(next);
  return next;
}

/**
 * If a side has no seeds in any of its six pits, move all opposite-side
 * seeds into that side's store and zero out their pits. Mutates state in
 * place. Called from applyMove.
 */
function endgameSweep(state: MancalaState) {
  const p0Empty = state.pits.slice(0, PITS_PER_SIDE).every((n) => n === 0);
  const p1Empty = state.pits.slice(PITS_PER_SIDE + 1, STORE_1).every((n) => n === 0);
  if (!p0Empty && !p1Empty) return;
  // Sweep p1's pits into p1's store.
  if (p0Empty) {
    let sum = 0;
    for (let i = PITS_PER_SIDE + 1; i < STORE_1; i++) {
      sum += state.pits[i];
      state.pits[i] = 0;
    }
    state.pits[STORE_1] += sum;
  } else if (p1Empty) {
    let sum = 0;
    for (let i = 0; i < PITS_PER_SIDE; i++) {
      sum += state.pits[i];
      state.pits[i] = 0;
    }
    state.pits[STORE_0] += sum;
  }
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

export function checkResult(state: MancalaState): MancalaResult {
  // Game is over when one side has no seeds in pits AND no legal moves.
  // (The sweep happens in applyMove, so when neither side has playable
  // pits, the game is decided.)
  const p0HasSeeds = state.pits.slice(0, PITS_PER_SIDE).some((n) => n > 0);
  const p1HasSeeds = state.pits.slice(PITS_PER_SIDE + 1, STORE_1).some((n) => n > 0);
  if (p0HasSeeds && p1HasSeeds) return { status: "ongoing" };
  const s0 = state.pits[STORE_0];
  const s1 = state.pits[STORE_1];
  if (s0 > s1) return { status: "win", winner: "0", stores: { "0": s0, "1": s1 } };
  if (s1 > s0) return { status: "win", winner: "1", stores: { "0": s0, "1": s1 } };
  return { status: "draw", stores: { "0": s0, "1": s1 } };
}

// ---------------------------------------------------------------------------
// boardgame.io
// ---------------------------------------------------------------------------

export const game: Game<MancalaState> = {
  name: "mancala",
  setup: () => startingState(),
  turn: { minMoves: 1, maxMoves: 1 },
  moves: {
    sow: ({ G, playerID }, raw: unknown) => {
      if (G.turn !== playerID) return INVALID_MOVE;
      const arg = raw as { pit?: unknown };
      const pit = Number(arg.pit);
      if (!Number.isInteger(pit)) return INVALID_MOVE;
      if (!isLegalMove(G, pit)) return INVALID_MOVE;

      const next = applyMove(G, { pit });
      G.pits = next.pits;
      G.turn = next.turn;
      G.lastMove = next.lastMove;
    },
  },
  endIf: ({ G }) => {
    const r = checkResult(G);
    if (r.status === "win") return { winner: r.winner };
    if (r.status === "draw") return { draw: true };
  },
};
