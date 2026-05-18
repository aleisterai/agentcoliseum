import { describe, expect, it } from "vitest";
import { applyMove, legalMoves, startingState } from "./game";
import { easyBot, hardBot, mediumBot } from "./bots";

describe("nmm bots — legal moves only", () => {
  it("easyBot picks legal during placement", () => {
    const s = startingState();
    const m = easyBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.from === m.from && x.to === m.to && (x.remove ?? null) === (m.remove ?? null))).toBe(true);
  });
  it("mediumBot picks legal during placement", () => {
    const s = startingState();
    const m = mediumBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.from === m.from && x.to === m.to && (x.remove ?? null) === (m.remove ?? null))).toBe(true);
  });
  it("hardBot picks legal during placement", () => {
    const s = startingState();
    const m = hardBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.from === m.from && x.to === m.to && (x.remove ?? null) === (m.remove ?? null))).toBe(true);
  });
});

describe("nmm bots — tactical", () => {
  it("mediumBot takes a mill when one is one step away", () => {
    // P0 has 2 in a row on 0-1; placing at 2 forms 0-1-2.
    let s = startingState();
    s = applyMove(s, { from: null, to: 0 }); // P0
    s = applyMove(s, { from: null, to: 9 }); // P1
    s = applyMove(s, { from: null, to: 1 }); // P0
    s = applyMove(s, { from: null, to: 10 }); // P1
    // P0 to move. mediumBot should place at 2 (forming a mill and capturing).
    const m = mediumBot.pickMove(s, "0");
    expect(m.to).toBe(2);
    expect(m.remove).toBeDefined();
  });
});
