/**
 * Liar's Dice (2-player, no-wild variant) — rules engine + boardgame.io game.
 *
 * Each player has a cup of up to 5 six-sided dice, rolled SECRETLY at the
 * start of every round (hidden from the opponent — this is an imperfect-
 * information game). Players alternate actions:
 *
 *   • BID {quantity, face} — claim that at least `quantity` dice showing
 *     `face` exist across BOTH cups combined. Each bid must be strictly
 *     higher than the standing bid: higher quantity, or equal quantity +
 *     higher face. (1s are NOT wild in this variant.)
 *   • CHALLENGE — call the standing bid a lie. Both cups are revealed and
 *     the dice showing the bid face are counted across the table:
 *       actual ≥ quantity → bid was TRUE  → the CHALLENGER loses a die.
 *       actual <  quantity → bid was a LIE → the BIDDER loses a die.
 *
 * The loser of a challenge drops one die and STARTS the next round's
 * bidding; both cups are re-rolled. A player who loses their last die is
 * eliminated and the opponent wins.
 *
 * Determinism: dice are rolled with boardgame.io's seeded `random` inside
 * `turn.onBegin` (the seed lives in ctx._random and is persisted with the
 * match state), so replays are exact. All other logic is pure.
 *
 * Move payloads (see api-contract.ts):
 *   { kind: "bid", quantity, face }
 *   { kind: "challenge" }
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const DICE_PER_PLAYER = 5;
export const FACES = 6;

export type PlayerId = "0" | "1";

export interface Bid {
  quantity: number;
  face: number; // 1..6
}

export interface ChallengeRecord {
  challenger: PlayerId;
  bidder: PlayerId;
  bid: Bid;
  actualCount: number;
  bidWasTrue: boolean;
  loser: PlayerId;
  /** Dice revealed at the challenge (public after reveal). */
  revealed: { "0": number[]; "1": number[] };
}

export type LiarsDiceMove =
  | { kind: "bid"; quantity: number; face: number }
  | { kind: "challenge" };

export interface LiarsDiceState {
  dice: { "0": number[]; "1": number[] }; // current secret rolls
  diceCount: { "0": number; "1": number }; // dice remaining each
  bid: Bid | null; // standing bid this round
  bidder: PlayerId | null;
  turn: PlayerId;
  round: number;
  /** When true, turn.onBegin rolls fresh dice (round start). */
  rerollPending: boolean;
  /** Result of the most recent challenge (for reveal UI), else null. */
  lastChallenge: ChallengeRecord | null;
  lastMove: LiarsDiceMove | null;
}

export type LiarsDiceResult =
  | { status: "ongoing" }
  | { status: "win"; winner: PlayerId };

export function opposite(p: PlayerId): PlayerId {
  return p === "0" ? "1" : "0";
}

export function startingState(): LiarsDiceState {
  return {
    dice: { "0": [], "1": [] }, // rolled by onBegin on the first turn
    diceCount: { "0": DICE_PER_PLAYER, "1": DICE_PER_PLAYER },
    bid: null,
    bidder: null,
    turn: "0",
    round: 1,
    rerollPending: true,
    lastChallenge: null,
    lastMove: null,
  };
}

export function cloneState(s: LiarsDiceState): LiarsDiceState {
  return {
    dice: { "0": s.dice["0"].slice(), "1": s.dice["1"].slice() },
    diceCount: { "0": s.diceCount["0"], "1": s.diceCount["1"] },
    bid: s.bid ? { ...s.bid } : null,
    bidder: s.bidder,
    turn: s.turn,
    round: s.round,
    rerollPending: s.rerollPending,
    lastChallenge: s.lastChallenge
      ? {
          ...s.lastChallenge,
          bid: { ...s.lastChallenge.bid },
          revealed: {
            "0": s.lastChallenge.revealed["0"].slice(),
            "1": s.lastChallenge.revealed["1"].slice(),
          },
        }
      : null,
    lastMove: s.lastMove ? { ...s.lastMove } : null,
  };
}

/** Total dice currently on the table (both cups). Caps bid quantity. */
export function totalDiceOnTable(s: LiarsDiceState): number {
  return s.diceCount["0"] + s.diceCount["1"];
}

/** True if `next` is a strictly-higher bid than `prev`. */
export function bidIsHigher(prev: Bid, next: Bid): boolean {
  if (next.quantity > prev.quantity) return true;
  if (next.quantity === prev.quantity && next.face > prev.face) return true;
  return false;
}

/** Count dice across both cups showing `face`. */
export function countFace(s: LiarsDiceState, face: number): number {
  let n = 0;
  for (const d of s.dice["0"]) if (d === face) n++;
  for (const d of s.dice["1"]) if (d === face) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

export function isLegalMove(s: LiarsDiceState, m: LiarsDiceMove): boolean {
  // Dice must be rolled before any action (onBegin handles this; guards tests).
  if (s.rerollPending) return false;

  if (m.kind === "bid") {
    if (!Number.isInteger(m.quantity) || !Number.isInteger(m.face)) return false;
    if (m.face < 1 || m.face > FACES) return false;
    if (m.quantity < 1 || m.quantity > totalDiceOnTable(s)) return false;
    if (s.bid === null) return true; // any opening bid
    return bidIsHigher(s.bid, { quantity: m.quantity, face: m.face });
  }
  // challenge — only legal when there's a standing bid to call
  return s.bid !== null;
}

export function legalMoves(s: LiarsDiceState): LiarsDiceMove[] {
  const out: LiarsDiceMove[] = [];
  if (s.rerollPending) return out;
  const cap = totalDiceOnTable(s);
  for (let q = 1; q <= cap; q++) {
    for (let f = 1; f <= FACES; f++) {
      const bid: LiarsDiceMove = { kind: "bid", quantity: q, face: f };
      if (isLegalMove(s, bid)) out.push(bid);
    }
  }
  if (s.bid !== null) out.push({ kind: "challenge" });
  return out;
}

// ---------------------------------------------------------------------------
// Apply (pure — dice rolling is done separately by onBegin via `random`)
// ---------------------------------------------------------------------------

export function applyBid(s: LiarsDiceState, bid: Bid): LiarsDiceState {
  const next = cloneState(s);
  next.bid = { ...bid };
  next.bidder = s.turn;
  next.turn = opposite(s.turn);
  next.lastMove = { kind: "bid", quantity: bid.quantity, face: bid.face };
  next.lastChallenge = null;
  return next;
}

/**
 * Resolve a challenge against the standing bid. Deterministic given the
 * current dice. Decrements the loser's die count, records the reveal, and
 * sets up the next round (loser bids first; rerollPending so onBegin
 * re-rolls). Throws if there's no standing bid.
 */
export function resolveChallenge(s: LiarsDiceState): LiarsDiceState {
  if (s.bid === null) throw new Error("cannot challenge with no standing bid");
  const challenger = s.turn;
  const bidder = s.bidder!;
  const actualCount = countFace(s, s.bid.face);
  const bidWasTrue = actualCount >= s.bid.quantity;
  const loser: PlayerId = bidWasTrue ? challenger : bidder;

  const next = cloneState(s);
  next.lastChallenge = {
    challenger,
    bidder,
    bid: { ...s.bid },
    actualCount,
    bidWasTrue,
    loser,
    revealed: { "0": s.dice["0"].slice(), "1": s.dice["1"].slice() },
  };
  next.diceCount[loser] = Math.max(0, s.diceCount[loser] - 1);
  next.bid = null;
  next.bidder = null;
  next.round = s.round + 1;
  next.turn = loser; // loser starts next round
  next.rerollPending = true; // onBegin rolls fresh cups
  next.lastMove = { kind: "challenge" };
  return next;
}

export function checkResult(s: LiarsDiceState): LiarsDiceResult {
  if (s.diceCount["0"] <= 0) return { status: "win", winner: "1" };
  if (s.diceCount["1"] <= 0) return { status: "win", winner: "0" };
  return { status: "ongoing" };
}

// ---------------------------------------------------------------------------
// boardgame.io
// ---------------------------------------------------------------------------

export const game: Game<LiarsDiceState> = {
  name: "liars-dice",
  setup: () => startingState(),
  turn: {
    minMoves: 1,
    maxMoves: 1,
    // Turn order is driven by G.turn (loser-starts-next-round breaks strict
    // alternation), so first/next read it directly.
    order: {
      first: () => 0,
      next: ({ G }) => Number(G.turn),
    },
    // Roll fresh secret cups at the start of any round. Seeded `random` →
    // deterministic + replayable; the seed rides in ctx._random.
    onBegin: ({ G, random }) => {
      if (G.rerollPending) {
        G.dice = {
          "0": G.diceCount["0"] > 0 ? (random.D6(G.diceCount["0"]) as number[]) : [],
          "1": G.diceCount["1"] > 0 ? (random.D6(G.diceCount["1"]) as number[]) : [],
        };
        G.rerollPending = false;
      }
    },
  },
  moves: {
    bid: ({ G, playerID }, raw: unknown) => {
      if (G.turn !== playerID) return INVALID_MOVE;
      const arg = raw as { quantity?: unknown; face?: unknown };
      const quantity = Number(arg?.quantity);
      const face = Number(arg?.face);
      const m: LiarsDiceMove = { kind: "bid", quantity, face };
      if (!isLegalMove(G, m)) return INVALID_MOVE;
      const next = applyBid(G, { quantity, face });
      G.bid = next.bid;
      G.bidder = next.bidder;
      G.turn = next.turn;
      G.lastMove = next.lastMove;
      G.lastChallenge = next.lastChallenge;
    },
    challenge: ({ G, playerID }) => {
      if (G.turn !== playerID) return INVALID_MOVE;
      if (!isLegalMove(G, { kind: "challenge" })) return INVALID_MOVE;
      const next = resolveChallenge(G);
      G.dice = next.dice;
      G.diceCount = next.diceCount;
      G.bid = next.bid;
      G.bidder = next.bidder;
      G.turn = next.turn;
      G.round = next.round;
      G.rerollPending = next.rerollPending;
      G.lastChallenge = next.lastChallenge;
      G.lastMove = next.lastMove;
    },
  },
  endIf: ({ G }) => {
    const r = checkResult(G);
    if (r.status === "win") return { winner: r.winner };
  },
};
