import { describe, expect, it } from "vitest";
import { easyBot, mediumBot, hardBot } from "./bots";
import {
  isLegalMove,
  type Bid,
  type LiarsDiceState,
  type PlayerId,
} from "./game";

function mk(
  dice0: number[],
  dice1: number[],
  opts: { bid?: Bid | null; bidder?: PlayerId | null; turn?: PlayerId } = {},
): LiarsDiceState {
  return {
    dice: { "0": dice0.slice(), "1": dice1.slice() },
    diceCount: { "0": dice0.length, "1": dice1.length },
    bid: opts.bid ?? null,
    bidder: opts.bidder ?? null,
    turn: opts.turn ?? "0",
    round: 1,
    rerollPending: false,
    lastChallenge: null,
    lastMove: null,
  };
}

describe("liars-dice bots — legal moves only", () => {
  for (const [name, bot] of [
    ["easy", easyBot],
    ["medium", mediumBot],
    ["hard", hardBot],
  ] as const) {
    it(`${name}Bot opens with a legal bid`, () => {
      const s = mk([2, 2, 4, 5, 6], [3, 3, 1, 1, 6]);
      const m = bot.pickMove(s, "0");
      expect(isLegalMove(s, m)).toBe(true);
    });
    it(`${name}Bot responds legally to a standing bid`, () => {
      const s = mk([2, 2, 4, 5, 6], [3, 3, 1, 1, 6], {
        bid: { quantity: 2, face: 2 },
        bidder: "0",
        turn: "1",
      });
      const m = bot.pickMove(s, "1");
      expect(isLegalMove(s, m)).toBe(true);
    });
  }
});

describe("liars-dice bots — judgment", () => {
  it("hardBot challenges an impossible bid", () => {
    // P1 holds zero 4s; opponent has 5 dice; bid claims six 4s → impossible.
    const s = mk([1, 2, 3, 5, 6], [1, 2, 3, 5, 6], {
      bid: { quantity: 6, face: 4 },
      bidder: "0",
      turn: "1",
    });
    const m = hardBot.pickMove(s, "1");
    expect(m.kind).toBe("challenge");
  });

  it("mediumBot challenges a bid above the table maximum it can see", () => {
    // P1 has no 4s; max possible 4s = its own 0 + opp's ≤5 = 5; bid 6 → call.
    const s = mk([1, 1, 1, 1, 1], [2, 3, 5, 6, 6], {
      bid: { quantity: 6, face: 4 },
      bidder: "0",
      turn: "1",
    });
    const m = mediumBot.pickMove(s, "1");
    expect(m.kind).toBe("challenge");
  });

  it("hardBot raises (doesn't fold) when the standing bid is very plausible", () => {
    // P1 holds three 5s itself; a bid of two 5s is trivially safe → raise.
    const s = mk([1, 2, 3, 4, 6], [5, 5, 5, 2, 1], {
      bid: { quantity: 2, face: 5 },
      bidder: "0",
      turn: "1",
    });
    const m = hardBot.pickMove(s, "1");
    expect(m.kind).toBe("bid");
  });
});
