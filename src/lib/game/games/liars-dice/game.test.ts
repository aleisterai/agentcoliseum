import { describe, expect, it } from "vitest";
import { buildEngine } from "@/lib/game/engine";
import {
  DICE_PER_PLAYER,
  applyBid,
  bidIsHigher,
  checkResult,
  countFace,
  game,
  isLegalMove,
  legalMoves,
  resolveChallenge,
  startingState,
  type Bid,
  type LiarsDiceState,
  type PlayerId,
} from "./game";
import { hardBot } from "./bots";

/** Build a mid-round state with fixed dice (rerollPending false). */
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

describe("liars-dice — setup + bid ordering", () => {
  it("starts with 5 dice each, P0 to move, reroll pending", () => {
    const s = startingState();
    expect(s.diceCount).toEqual({ "0": DICE_PER_PLAYER, "1": DICE_PER_PLAYER });
    expect(s.turn).toBe("0");
    expect(s.rerollPending).toBe(true);
  });
  it("bidIsHigher: higher quantity, or equal quantity + higher face", () => {
    expect(bidIsHigher({ quantity: 2, face: 3 }, { quantity: 2, face: 4 })).toBe(true);
    expect(bidIsHigher({ quantity: 2, face: 4 }, { quantity: 3, face: 1 })).toBe(true);
    expect(bidIsHigher({ quantity: 3, face: 5 }, { quantity: 3, face: 4 })).toBe(false);
    expect(bidIsHigher({ quantity: 3, face: 5 }, { quantity: 2, face: 6 })).toBe(false);
    expect(bidIsHigher({ quantity: 2, face: 3 }, { quantity: 2, face: 3 })).toBe(false);
  });
  it("countFace counts across both cups", () => {
    const s = mk([4, 4, 2, 1, 6], [4, 3, 3, 5, 2]);
    expect(countFace(s, 4)).toBe(3);
    expect(countFace(s, 3)).toBe(2);
  });
});

describe("liars-dice — legality", () => {
  it("any opening bid is legal; challenge needs a standing bid", () => {
    const s = mk([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
    expect(isLegalMove(s, { kind: "bid", quantity: 1, face: 1 })).toBe(true);
    expect(isLegalMove(s, { kind: "challenge" })).toBe(false);
  });
  it("a raise must be strictly higher; lower/equal rejected", () => {
    const s = mk([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], {
      bid: { quantity: 3, face: 4 },
      bidder: "0",
      turn: "1",
    });
    expect(isLegalMove(s, { kind: "bid", quantity: 3, face: 5 })).toBe(true);
    expect(isLegalMove(s, { kind: "bid", quantity: 4, face: 1 })).toBe(true);
    expect(isLegalMove(s, { kind: "bid", quantity: 3, face: 4 })).toBe(false);
    expect(isLegalMove(s, { kind: "bid", quantity: 2, face: 6 })).toBe(false);
    expect(isLegalMove(s, { kind: "challenge" })).toBe(true);
  });
  it("quantity can't exceed total dice on the table; face must be 1..6", () => {
    const s = mk([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]); // 10 dice total
    expect(isLegalMove(s, { kind: "bid", quantity: 11, face: 3 })).toBe(false);
    expect(isLegalMove(s, { kind: "bid", quantity: 1, face: 7 })).toBe(false);
    expect(isLegalMove(s, { kind: "bid", quantity: 10, face: 6 })).toBe(true);
  });
  it("no action is legal while a reroll is pending", () => {
    const s = startingState(); // rerollPending true
    expect(legalMoves(s)).toHaveLength(0);
  });
});

describe("liars-dice — challenge resolution", () => {
  it("true bid → challenger loses a die; loser starts next round", () => {
    // face-4 count across cups = 3. Bid (3,4) by P0, P1 challenges.
    const s = mk([4, 4, 2, 1, 6], [4, 3, 3, 5, 2], {
      bid: { quantity: 3, face: 4 },
      bidder: "0",
      turn: "1",
    });
    const next = resolveChallenge(s);
    expect(next.lastChallenge?.bidWasTrue).toBe(true);
    expect(next.lastChallenge?.actualCount).toBe(3);
    expect(next.lastChallenge?.loser).toBe("1"); // challenger
    expect(next.diceCount).toEqual({ "0": 5, "1": 4 });
    expect(next.turn).toBe("1"); // loser bids next
    expect(next.rerollPending).toBe(true);
    expect(next.round).toBe(2);
    expect(next.bid).toBeNull();
  });
  it("lie → bidder loses a die", () => {
    // face-4 count = 3 < bid 5 → lie. Bidder P0 loses.
    const s = mk([4, 4, 2, 1, 6], [4, 3, 3, 5, 2], {
      bid: { quantity: 5, face: 4 },
      bidder: "0",
      turn: "1",
    });
    const next = resolveChallenge(s);
    expect(next.lastChallenge?.bidWasTrue).toBe(false);
    expect(next.lastChallenge?.loser).toBe("0"); // bidder
    expect(next.diceCount).toEqual({ "0": 4, "1": 5 });
    expect(next.turn).toBe("0");
  });
  it("applyBid flips the turn + records the bidder", () => {
    const s = mk([1, 1, 1, 1, 1], [2, 2, 2, 2, 2]);
    const next = applyBid(s, { quantity: 2, face: 1 });
    expect(next.bid).toEqual({ quantity: 2, face: 1 });
    expect(next.bidder).toBe("0");
    expect(next.turn).toBe("1");
  });
});

describe("liars-dice — termination", () => {
  it("a player at 0 dice loses", () => {
    const s = mk([], [1, 2, 3], { turn: "1" });
    const r = checkResult(s);
    expect(r.status).toBe("win");
    if (r.status === "win") expect(r.winner).toBe("1");
  });
});

describe("liars-dice — engine self-play (e2e, seeded dice)", () => {
  it("plays a full game to a terminal state through the real reducer", () => {
    const engine = buildEngine(game);
    let state = engine.initialState();
    let over = engine.gameOver(state);
    let plies = 0;
    // After onBegin rolls, dice must be populated (proves seeded RNG fired).
    expect((state.G as LiarsDiceState).dice["0"].length).toBe(DICE_PER_PLAYER);
    while (!over && plies < 400) {
      const G = state.G as LiarsDiceState;
      const move = hardBot.pickMove(G, G.turn);
      const next = engine.applyMove(state, G.turn, move.kind, move.kind === "bid" ? [{ quantity: move.quantity, face: move.face }] : []);
      expect(next, `engine rejected a legal ${move.kind} at ply ${plies}`).not.toBeNull();
      state = next!;
      over = engine.gameOver(state);
      plies += 1;
    }
    expect(over).not.toBeNull();
    // Someone was reduced to zero dice.
    const g = state.G as LiarsDiceState;
    expect(g.diceCount["0"] === 0 || g.diceCount["1"] === 0).toBe(true);
  });
});
