/**
 * Backgammon system bots.
 *
 * All three pick from `legalTurns()` — the set of fully-legal maximal turns
 * for the current dice — so whatever they return is guaranteed legal (correct
 * dice usage, bar-first, bear-off rules). They differ only in how they choose:
 *
 *   easy   → a random legal turn.
 *   medium → greedy on a race/safety eval, random tie-break.
 *   hard   → same eval, heavier on safety, DETERMINISTIC tie-break (first
 *            best by enumeration order) so self-play replays exactly.
 *
 * The eval rewards: being ahead in the pip race (hitting a blot sends it to
 * the bar = +25 opp pips, so hits fall out for free), bearing checkers off,
 * and penalises own checkers on the bar + own blots left exposed.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  countBlots,
  legalTurns,
  opposite,
  pipCount,
  type BackgammonMove,
  type BackgammonState,
  type PlayerId,
  type TurnSeq,
} from "./game";

function evalEnd(t: TurnSeq, me: PlayerId, blotWeight: number): number {
  const opp = opposite(me);
  const race = pipCount(t.end, opp) - pipCount(t.end, me);
  const borne = 15 * (t.end.off[me] - t.end.off[opp]);
  const barPenalty = 8 * t.end.bar[me];
  const blotPenalty = blotWeight * countBlots(t.end, me);
  return race + borne - barPenalty - blotPenalty;
}

function pass(): BackgammonMove {
  return { kind: "play", moves: [] };
}

export const easyBot: BotStrategy<BackgammonState, BackgammonMove> = {
  pickMove: (state, playerID) => {
    const turns = legalTurns(state, playerID);
    if (turns.length === 0) return pass();
    const pick = turns[Math.floor(Math.random() * turns.length)];
    return { kind: "play", moves: pick.seq };
  },
};

export const mediumBot: BotStrategy<BackgammonState, BackgammonMove> = {
  pickMove: (state, playerID) => {
    const me: PlayerId = playerID;
    const turns = legalTurns(state, me);
    if (turns.length === 0) return pass();
    let bestScore = -Infinity;
    const best: TurnSeq[] = [];
    for (const t of turns) {
      const sc = evalEnd(t, me, 3);
      if (sc > bestScore) {
        bestScore = sc;
        best.length = 0;
        best.push(t);
      } else if (sc === bestScore) {
        best.push(t);
      }
    }
    const pick = best[Math.floor(Math.random() * best.length)];
    return { kind: "play", moves: pick.seq };
  },
};

export const hardBot: BotStrategy<BackgammonState, BackgammonMove> = {
  pickMove: (state, playerID) => {
    const me: PlayerId = playerID;
    const turns = legalTurns(state, me);
    if (turns.length === 0) return pass();
    // Deterministic: highest eval, ties resolved by enumeration order (first).
    let best = turns[0];
    let bestScore = evalEnd(best, me, 5);
    for (let i = 1; i < turns.length; i++) {
      const sc = evalEnd(turns[i], me, 5);
      if (sc > bestScore) {
        bestScore = sc;
        best = turns[i];
      }
    }
    return { kind: "play", moves: best.seq };
  },
};
