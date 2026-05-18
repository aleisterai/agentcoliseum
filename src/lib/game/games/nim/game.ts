/**
 * Nim (classic, normal-play) — pure rules engine + boardgame.io game.
 *
 * Three piles, standard starting sizes (3, 4, 5). Players alternate turns.
 * On your turn pick one pile and remove 1..pile-size stones from it. The
 * player who takes the LAST stone WINS (normal play; the misère variant
 * — "last stone loses" — is not used here).
 *
 * Optimal play is the textbook XOR-sum: the position with nim-sum
 * `pile[0] XOR pile[1] XOR pile[2] = 0` is losing for the player to
 * move ("P-position"). The hard bot uses this to play perfectly.
 *
 * Move payload: `{ pile: number, take: number }`.
 *   - `pile` is the pile index (0–2).
 *   - `take` is the number of stones to remove (1..pile-size).
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const STARTING_PILES: ReadonlyArray<number> = [3, 4, 5];
export const NUM_PILES = STARTING_PILES.length;

export type PlayerId = "0" | "1";

export interface NimMove {
  pile: number;
  take: number;
}

export interface NimState {
  piles: number[]; // length NUM_PILES
  turn: PlayerId;
  lastMove: NimMove | null;
}

export type NimResult =
  | { status: "ongoing" }
  | { status: "win"; winner: PlayerId };

export function startingState(): NimState {
  return {
    piles: [...STARTING_PILES],
    turn: "0",
    lastMove: null,
  };
}

export function cloneState(s: NimState): NimState {
  return {
    piles: s.piles.slice(),
    turn: s.turn,
    lastMove: s.lastMove ? { ...s.lastMove } : null,
  };
}

export function opposite(p: PlayerId): PlayerId {
  return p === "0" ? "1" : "0";
}

// ---------------------------------------------------------------------------
// Legality + termination
// ---------------------------------------------------------------------------

export function isLegalMove(state: NimState, move: NimMove): boolean {
  if (!Number.isInteger(move.pile) || !Number.isInteger(move.take)) return false;
  if (move.pile < 0 || move.pile >= state.piles.length) return false;
  if (move.take < 1) return false;
  return move.take <= state.piles[move.pile];
}

export function legalMoves(state: NimState): NimMove[] {
  const out: NimMove[] = [];
  for (let i = 0; i < state.piles.length; i++) {
    for (let take = 1; take <= state.piles[i]; take++) {
      out.push({ pile: i, take });
    }
  }
  return out;
}

export function applyMove(state: NimState, move: NimMove): NimState {
  if (!isLegalMove(state, move)) {
    throw new Error(`illegal nim move pile=${move.pile} take=${move.take}`);
  }
  const next = cloneState(state);
  next.piles[move.pile] -= move.take;
  next.lastMove = { ...move };
  // Termination check BEFORE flipping turn — the moving player wins if
  // they just emptied the last pile.
  if (next.piles.every((n) => n === 0)) {
    // Don't flip turn; the result is "current player just won".
    // The result is reported via checkResult based on the empty-board state.
    return next;
  }
  next.turn = opposite(state.turn);
  return next;
}

/**
 * The XOR of all piles. Zero = the position is losing for the side to move
 * (P-position); non-zero = there exists a winning move.
 */
export function nimSum(piles: ReadonlyArray<number>): number {
  let x = 0;
  for (const p of piles) x ^= p;
  return x;
}

export function checkResult(state: NimState): NimResult {
  if (state.piles.every((n) => n === 0)) {
    // The player who took the last stone won. After applyMove on an
    // empty-board terminal state we DON'T flip turn, so state.turn is
    // the winning player.
    return { status: "win", winner: state.turn };
  }
  return { status: "ongoing" };
}

// ---------------------------------------------------------------------------
// boardgame.io
// ---------------------------------------------------------------------------

export const game: Game<NimState> = {
  name: "nim",
  setup: () => startingState(),
  turn: { minMoves: 1, maxMoves: 1 },
  moves: {
    take: ({ G, playerID }, raw: unknown) => {
      if (G.turn !== playerID) return INVALID_MOVE;
      const arg = raw as { pile?: unknown; take?: unknown };
      const pile = Number(arg.pile);
      const take = Number(arg.take);
      if (!isLegalMove(G, { pile, take })) return INVALID_MOVE;
      const next = applyMove(G, { pile, take });
      G.piles = next.piles;
      G.turn = next.turn;
      G.lastMove = next.lastMove;
    },
  },
  endIf: ({ G }) => {
    const r = checkResult(G);
    if (r.status === "win") return { winner: r.winner };
  },
};
