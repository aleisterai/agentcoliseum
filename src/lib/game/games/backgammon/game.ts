/**
 * Backgammon (2-player) — rules engine + boardgame.io game.
 *
 * Standard rules, no doubling cube and no gammon/backgammon multipliers (the
 * match stake is fixed when the challenge is created, so the cube + 2×/3×
 * scoring are out of scope — this is a straight race to bear off all 15).
 *
 * Board: 24 points, index 0..23, stored as a SIGNED count per point —
 * positive = player 0's checkers, negative = player 1's. Plus a `bar` and
 * `off` (borne-off) count per player.
 *
 *   • Player 0 moves toward index 0 (home board = 0..5), bears off past 0,
 *     and re-enters from the bar onto 24 − die (so die 1 → idx 23 … die 6 →
 *     idx 18).
 *   • Player 1 moves toward index 23 (home board = 18..23), bears off past
 *     23, and re-enters from the bar onto die − 1 (die 1 → idx 0 … 6 → 5).
 *
 * A point is BLOCKED for you if the opponent has ≥2 checkers on it; landing
 * on a lone opponent checker (a "blot") HITS it — that checker goes to the
 * bar and must re-enter before the owner does anything else.
 *
 * Dice (rolled with boardgame.io's seeded `random` in turn.onBegin → exact
 * replays): two dice = two moves; doubles = four moves of that value. You
 * must play as many dice as legally possible; if only one of two distinct
 * dice can be played, you must play the higher one. Both rules are enforced
 * by enumerating every legal maximal turn (the board is tiny, so this is
 * cheap) — a submitted turn is legal iff it reaches one of those end states.
 *
 * Move payload (see api-contract.ts):
 *   { moves: [ { from: 0..23 | "bar", to: 0..23 | "off" }, … ] }   // 0–4 hops
 *   { moves: [] }   // pass — ONLY when you have no legal move
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const POINTS = 24;
export const CHECKERS = 15;

export type PlayerId = "0" | "1";
export type Loc = number | "bar" | "off";
export interface SubMove {
  from: number | "bar";
  to: number | "off";
}
export type BackgammonMove = { kind: "play"; moves: SubMove[] };

export interface BackgammonState {
  /** Signed per-point counts: + = player 0, − = player 1, 0 = empty. */
  points: number[];
  bar: { "0": number; "1": number };
  off: { "0": number; "1": number };
  turn: PlayerId;
  /** Remaining usable dice this turn (doubles expand to four). */
  dice: number[];
  /** The raw two-dice roll, for display. */
  rolled: [number, number] | null;
  /** turn.onBegin rolls fresh dice when true. */
  rollPending: boolean;
  lastMove: BackgammonMove | null;
}

export type BackgammonResult =
  | { status: "ongoing" }
  | { status: "win"; winner: PlayerId };

export function opposite(p: PlayerId): PlayerId {
  return p === "0" ? "1" : "0";
}
function sign(p: PlayerId): number {
  return p === "0" ? 1 : -1;
}

export function startingState(): BackgammonState {
  const points = new Array<number>(POINTS).fill(0);
  // Standard opening position (player 0 = +, moves 23→0).
  points[0] = -2;
  points[5] = 5;
  points[7] = 3;
  points[11] = -5;
  points[12] = 5;
  points[16] = -3;
  points[18] = -5;
  points[23] = 2;
  return {
    points,
    bar: { "0": 0, "1": 0 },
    off: { "0": 0, "1": 0 },
    turn: "0",
    dice: [],
    rolled: null,
    rollPending: true,
    lastMove: null,
  };
}

// ---------------------------------------------------------------------------
// Working state (compact, mutable) used by the enumerator + appliers.
// ---------------------------------------------------------------------------

export interface WS {
  pts: number[];
  bar: { "0": number; "1": number };
  off: { "0": number; "1": number };
}

/** Total pips `p` must still travel to bear off everything (lower = ahead).
 *  A checker on the bar counts as a full 25. */
export function pipCount(w: WS, p: PlayerId): number {
  const sg = sign(p);
  let total = w.bar[p] * 25;
  for (let i = 0; i < POINTS; i++) {
    const c = w.pts[i] * sg;
    if (c > 0) total += c * (p === "0" ? i + 1 : POINTS - i);
  }
  return total;
}

/** Count of `p`'s blots (points holding exactly one of their checkers). */
export function countBlots(w: WS, p: PlayerId): number {
  const sg = sign(p);
  let n = 0;
  for (let i = 0; i < POINTS; i++) if (w.pts[i] * sg === 1) n += 1;
  return n;
}

function toWS(s: BackgammonState): WS {
  return {
    pts: s.points.slice(),
    bar: { ...s.bar },
    off: { ...s.off },
  };
}
function cloneWS(w: WS): WS {
  return { pts: w.pts.slice(), bar: { ...w.bar }, off: { ...w.off } };
}
/** Stable signature of a board, for end-state set membership. */
export function wsKey(w: WS): string {
  return `${w.pts.join(",")}|${w.bar["0"]},${w.bar["1"]}|${w.off["0"]},${w.off["1"]}`;
}

function homeLo(p: PlayerId): number {
  return p === "0" ? 0 : 18;
}
function homeHi(p: PlayerId): number {
  return p === "0" ? 5 : 23;
}

/** All 15 of `p`'s checkers in the home board or already off → may bear off. */
export function allHome(w: WS, p: PlayerId): boolean {
  if (w.bar[p] > 0) return false;
  const sg = sign(p);
  const lo = homeLo(p);
  const hi = homeHi(p);
  for (let i = 0; i < POINTS; i++) {
    if (i >= lo && i <= hi) continue;
    if (w.pts[i] * sg > 0) return false; // a checker outside home
  }
  return true;
}

/** Entry point index when re-entering from the bar with `die`. */
function barEntry(p: PlayerId, die: number): number {
  return p === "0" ? 24 - die : die - 1;
}

/** Can `p` land on point index `i`? (in range + not blocked by ≥2 opp). */
function canLand(w: WS, p: PlayerId, i: number): boolean {
  if (i < 0 || i >= POINTS) return false;
  return w.pts[i] * sign(p) >= -1; // empty, own, or a lone blot
}

/**
 * Legal single moves for one die value from a working state. Honours the
 * bar-first rule, blocking, and bear-off (exact, or a higher die off the
 * highest occupied point).
 */
export function singleMoves(w: WS, p: PlayerId, die: number): SubMove[] {
  const sg = sign(p);
  // Bar first: must re-enter before anything else.
  if (w.bar[p] > 0) {
    const e = barEntry(p, die);
    return canLand(w, p, e) ? [{ from: "bar", to: e }] : [];
  }
  const out: SubMove[] = [];
  const bearing = allHome(w, p);
  for (let i = 0; i < POINTS; i++) {
    if (w.pts[i] * sg <= 0) continue; // not your checker
    const dest = i - sg * die; // player0 decreases, player1 increases
    if (dest >= 0 && dest < POINTS) {
      if (canLand(w, p, dest)) out.push({ from: i, to: dest });
      continue;
    }
    // dest off the board → bear-off candidate
    if (!bearing) continue;
    const exact = p === "0" ? i + 1 : POINTS - i; // pips needed to bear off i
    if (die === exact) {
      out.push({ from: i, to: "off" });
    } else if (die > exact) {
      // Higher die may bear off only the highest checker (no checker on a
      // point further from home within the home board).
      let higherOccupied = false;
      if (p === "0") {
        for (let j = i + 1; j <= homeHi(p); j++) if (w.pts[j] > 0) higherOccupied = true;
      } else {
        for (let j = homeLo(p); j < i; j++) if (w.pts[j] < 0) higherOccupied = true;
      }
      if (!higherOccupied) out.push({ from: i, to: "off" });
    }
  }
  return out;
}

/** Apply a single (already-legal) submove to a working state, in place. */
export function applySingle(w: WS, p: PlayerId, m: SubMove): void {
  const sg = sign(p);
  if (m.from === "bar") {
    w.bar[p] -= 1;
  } else {
    w.pts[m.from] -= sg;
  }
  if (m.to === "off") {
    w.off[p] += 1;
    return;
  }
  // Hit a blot?
  if (w.pts[m.to] * sg === -1) {
    w.pts[m.to] = 0;
    w.bar[opposite(p)] += 1;
  }
  w.pts[m.to] += sg;
}

// ---------------------------------------------------------------------------
// Turn enumeration — every legal maximal sequence, with the standard
// "use the most dice / play the larger of two if only one" rules.
// ---------------------------------------------------------------------------

export interface TurnSeq {
  seq: SubMove[];
  end: WS;
  dice: number[]; // dice consumed, in order
}

function enumerateAll(w: WS, p: PlayerId, dice: number[]): TurnSeq[] {
  const results: TurnSeq[] = [];
  const walk = (cur: WS, remaining: number[], seq: SubMove[], used: number[]) => {
    let extended = false;
    // Try each DISTINCT remaining die value once (order of equal dice is
    // irrelevant) to keep the tree small.
    const tried = new Set<number>();
    for (let k = 0; k < remaining.length; k++) {
      const die = remaining[k];
      if (tried.has(die)) continue;
      tried.add(die);
      const moves = singleMoves(cur, p, die);
      for (const mv of moves) {
        const next = cloneWS(cur);
        applySingle(next, p, mv);
        const rem = remaining.slice();
        rem.splice(rem.indexOf(die), 1);
        extended = true;
        walk(next, rem, [...seq, mv], [...used, die]);
      }
    }
    if (!extended && seq.length > 0) {
      results.push({ seq, end: cur, dice: used });
    }
  };
  walk(w, dice, [], []);
  return results;
}

/**
 * The legal maximal turns from a position. Applies the two standard
 * constraints:
 *   1. use the maximum number of dice any legal sequence can use;
 *   2. if that maximum is 1 and the two dice differ, you must use the higher
 *      die if a 1-die sequence with it exists.
 * Returns [] when the player has no legal move (a forced pass).
 */
export function legalTurns(s: BackgammonState, p: PlayerId): TurnSeq[] {
  const w = toWS(s);
  const all = enumerateAll(w, p, s.dice);
  if (all.length === 0) return [];
  const maxLen = Math.max(...all.map((t) => t.seq.length));
  let best = all.filter((t) => t.seq.length === maxLen);
  if (maxLen === 1 && s.dice.length === 2 && s.dice[0] !== s.dice[1]) {
    const higher = Math.max(s.dice[0], s.dice[1]);
    const withHigher = best.filter((t) => t.dice[0] === higher);
    if (withHigher.length > 0) best = withHigher;
  }
  return best;
}

/** Distinct legal end-state signatures for the current turn. */
function legalEndKeys(s: BackgammonState): Set<string> {
  return new Set(legalTurns(s, s.turn).map((t) => wsKey(t.end)));
}

export function hasAnyMove(s: BackgammonState): boolean {
  return legalTurns(s, s.turn).length > 0;
}

// ---------------------------------------------------------------------------
// Validate + apply a submitted turn (from/to hops, no die bookkeeping needed
// — we match the resulting board against the set of legal maximal ends).
// ---------------------------------------------------------------------------

export interface ApplyTurnResult {
  ok: boolean;
  error?: string;
  next?: WS;
}

/** Light per-hop legality so we don't accept a teleport that coincidentally
 *  lands on a legal end. Mirrors singleMoves' rules but ignores dice. */
function hopLooksLegal(w: WS, p: PlayerId, m: SubMove): boolean {
  const sg = sign(p);
  if (w.bar[p] > 0 && m.from !== "bar") return false; // bar first
  if (m.from === "bar") {
    if (w.bar[p] <= 0) return false;
  } else {
    if (m.from < 0 || m.from >= POINTS || w.pts[m.from] * sg <= 0) return false;
  }
  if (m.to === "off") return allHome(w, p);
  if (!canLand(w, p, m.to)) return false;
  // Direction: player 0 moves to a lower index, player 1 to a higher one.
  if (m.from !== "bar") {
    if (p === "0" && m.to >= m.from) return false;
    if (p === "1" && m.to <= m.from) return false;
  }
  return true;
}

export function applyTurn(
  s: BackgammonState,
  p: PlayerId,
  moves: SubMove[],
): ApplyTurnResult {
  if (s.turn !== p) return { ok: false, error: "not your turn" };
  const legal = legalTurns(s, p);

  // Pass: only valid when there is genuinely no legal move.
  if (moves.length === 0) {
    if (legal.length === 0) return { ok: true, next: toWS(s) };
    return { ok: false, error: "you have a legal move; pass not allowed" };
  }
  if (legal.length === 0) {
    return { ok: false, error: "no legal moves this turn — submit { moves: [] }" };
  }

  const ends = legalEndKeys(s);
  const w = toWS(s);
  for (const m of moves) {
    if (!hopLooksLegal(w, p, m)) return { ok: false, error: `illegal hop ${JSON.stringify(m)}` };
    applySingle(w, p, m);
  }
  if (!ends.has(wsKey(w))) {
    return {
      ok: false,
      error: "move sequence isn't a legal full turn (use the maximum dice; play the higher die if only one is playable)",
    };
  }
  return { ok: true, next: w };
}

export function checkResult(s: BackgammonState): BackgammonResult {
  if (s.off["0"] >= CHECKERS) return { status: "win", winner: "0" };
  if (s.off["1"] >= CHECKERS) return { status: "win", winner: "1" };
  return { status: "ongoing" };
}

// ---------------------------------------------------------------------------
// boardgame.io
// ---------------------------------------------------------------------------

function rollInto(G: BackgammonState, d: number[]): void {
  const [a, b] = d as [number, number];
  G.rolled = [a, b];
  G.dice = a === b ? [a, a, a, a] : [a, b];
  G.rollPending = false;
}

export const game: Game<BackgammonState> = {
  name: "backgammon",
  setup: () => startingState(),
  turn: {
    minMoves: 1,
    maxMoves: 1,
    order: {
      first: () => 0,
      next: ({ G }) => Number(G.turn),
    },
    // Roll fresh dice at the start of every turn (seeded → replayable).
    onBegin: ({ G, random }) => {
      if (G.rollPending) rollInto(G, random.D6(2) as number[]);
    },
  },
  moves: {
    play: ({ G, playerID }, raw: unknown) => {
      const me = playerID as PlayerId;
      if (G.turn !== me) return INVALID_MOVE;
      const arg = raw as { moves?: unknown };
      if (!Array.isArray(arg?.moves)) return INVALID_MOVE;
      const moves: SubMove[] = [];
      for (const item of arg.moves) {
        if (typeof item !== "object" || item === null) return INVALID_MOVE;
        const o = item as { from?: unknown; to?: unknown };
        const from =
          o.from === "bar"
            ? "bar"
            : Number.isInteger(o.from)
              ? (o.from as number)
              : null;
        const to =
          o.to === "off" ? "off" : Number.isInteger(o.to) ? (o.to as number) : null;
        if (from === null || to === null) return INVALID_MOVE;
        moves.push({ from, to });
      }
      const res = applyTurn(G, me, moves);
      if (!res.ok || !res.next) return INVALID_MOVE;

      G.points = res.next.pts;
      G.bar = res.next.bar;
      G.off = res.next.off;
      G.lastMove = { kind: "play", moves };
      G.turn = opposite(me);
      G.dice = [];
      G.rollPending = true;
    },
  },
  endIf: ({ G }) => {
    const r = checkResult(G);
    if (r.status === "win") return { winner: r.winner };
  },
};
