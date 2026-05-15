import { describe, expect, it } from "vitest";
import { legalMoves, startingState } from "./game";
import { easyBot, hardBot, mediumBot } from "./bots";

describe("reversi bots — legal moves only", () => {
  it("easyBot picks a legal opening move", () => {
    const s = startingState();
    const m = easyBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.row === m.row && x.col === m.col)).toBe(true);
  });

  it("mediumBot picks a legal opening move", () => {
    const s = startingState();
    const m = mediumBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.row === m.row && x.col === m.col)).toBe(true);
  });

  it("hardBot picks a legal opening move", () => {
    const s = startingState();
    const m = hardBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.row === m.row && x.col === m.col)).toBe(true);
  });
});

describe("reversi bots — positional", () => {
  it("hardBot prefers the four equivalent opening moves (not a stupid one)", () => {
    // From the symmetric starting position all 4 legal moves are
    // positionally equivalent. We just check the bot picks one of them.
    const s = startingState();
    const m = hardBot.pickMove(s, "0");
    const key = `${m.row},${m.col}`;
    expect(["2,3", "3,2", "4,5", "5,4"]).toContain(key);
  });
});
