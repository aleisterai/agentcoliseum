import { describe, expect, it } from "vitest";
import {
  STARTING_PILES,
  applyMove,
  checkResult,
  game,
  isLegalMove,
  legalMoves,
  nimSum,
  opposite,
  startingState,
} from "./game";

describe("nim — setup", () => {
  it("starting piles are [3, 4, 5], Player 0 to move", () => {
    const s = startingState();
    expect(s.piles).toEqual([3, 4, 5]);
    expect(s.turn).toBe("0");
    expect(s.lastMove).toBeNull();
  });

  it("opposite flips player", () => {
    expect(opposite("0")).toBe("1");
    expect(opposite("1")).toBe("0");
  });
});

describe("nim — legality + apply", () => {
  it("isLegalMove validates pile + take ranges", () => {
    const s = startingState();
    expect(isLegalMove(s, { pile: 0, take: 1 })).toBe(true);
    expect(isLegalMove(s, { pile: 0, take: 3 })).toBe(true);
    expect(isLegalMove(s, { pile: 0, take: 4 })).toBe(false); // > pile size
    expect(isLegalMove(s, { pile: 0, take: 0 })).toBe(false); // < 1
    expect(isLegalMove(s, { pile: 5, take: 1 })).toBe(false); // bad pile
    expect(isLegalMove(s, { pile: 0.5, take: 1 })).toBe(false); // non-integer
  });

  it("legalMoves enumerates every (pile, take) pair", () => {
    const moves = legalMoves(startingState());
    // 3 + 4 + 5 = 12 distinct moves
    expect(moves.length).toBe(3 + 4 + 5);
  });

  it("applyMove reduces the pile and flips turn", () => {
    const s = startingState();
    const next = applyMove(s, { pile: 1, take: 2 });
    expect(next.piles).toEqual([3, 2, 5]);
    expect(next.turn).toBe("1");
    expect(next.lastMove).toEqual({ pile: 1, take: 2 });
  });

  it("applyMove throws on illegal move", () => {
    const s = startingState();
    expect(() => applyMove(s, { pile: 0, take: 99 })).toThrow();
  });
});

describe("nim — termination", () => {
  it("emptying the last pile wins for the moving player; turn is NOT flipped", () => {
    // Set up a single-pile state.
    const s = startingState();
    s.piles = [0, 0, 3];
    s.turn = "0";
    const next = applyMove(s, { pile: 2, take: 3 });
    expect(next.piles).toEqual([0, 0, 0]);
    // Turn stays as the winning player so checkResult can identify them.
    expect(next.turn).toBe("0");
    const r = checkResult(next);
    expect(r.status).toBe("win");
    if (r.status === "win") expect(r.winner).toBe("0");
  });

  it("ongoing while any pile has stones", () => {
    const s = startingState();
    expect(checkResult(s).status).toBe("ongoing");
  });

  it("nim-sum: starting 3-4-5 has non-zero (winning for P0)", () => {
    expect(nimSum(STARTING_PILES)).not.toBe(0);
  });

  it("nim-sum of 0 means losing position for side to move", () => {
    expect(nimSum([3, 5, 6])).toBe(0); // P-position
    expect(nimSum([1, 2, 3])).toBe(0); // P-position
  });
});

describe("nim — boardgame.io", () => {
  it("setup matches starting state", () => {
    const initial = (game.setup as () => ReturnType<typeof startingState>)();
    expect(initial.piles).toEqual([3, 4, 5]);
  });
});
