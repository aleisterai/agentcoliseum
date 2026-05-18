import { describe, expect, it } from "vitest";
import { cellIdx, legalMoves, startingState, type SantoriniState } from "./game";
import { easyBot, hardBot, mediumBot } from "./bots";

describe("santorini bots — legal moves only", () => {
  it("easyBot picks legal at start", () => {
    const s = startingState();
    const m = easyBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => JSON.stringify(x) === JSON.stringify(m))).toBe(true);
  });
  it("mediumBot picks legal at start", () => {
    const s = startingState();
    const m = mediumBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => JSON.stringify(x) === JSON.stringify(m))).toBe(true);
  });
  it("hardBot picks legal at start", () => {
    const s = startingState();
    const m = hardBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => JSON.stringify(x) === JSON.stringify(m))).toBe(true);
  });
});

describe("santorini bots — tactical", () => {
  it("mediumBot takes a climb-to-3 win when available", () => {
    const s: SantoriniState = {
      levels: Array(25).fill(0),
      builders: {
        "0": [{ row: 1, col: 1 }, { row: 0, col: 4 }],
        "1": [{ row: 4, col: 0 }, { row: 4, col: 4 }],
      },
      turn: "0",
      lastMove: null,
    };
    s.levels[cellIdx(1, 1)] = 2;
    s.levels[cellIdx(2, 2)] = 3;
    const m = mediumBot.pickMove(s, "0");
    expect(m.builder).toBe(0);
    expect(m.to).toEqual({ row: 2, col: 2 });
  });
});
