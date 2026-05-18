import { describe, expect, it } from "vitest";
import { applyMove, legalMoves, startingState } from "./game";
import { easyBot, hardBot, mediumBot } from "./bots";

describe("hex bots — legal moves only", () => {
  it("easyBot picks legal on empty board", () => {
    const s = startingState();
    const m = easyBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.row === m.row && x.col === m.col)).toBe(true);
  });
  it("mediumBot opens at the center", () => {
    const s = startingState();
    const m = mediumBot.pickMove(s, "0");
    expect(m.row).toBe(5);
    expect(m.col).toBe(5);
  });
  it("hardBot opens at the center", () => {
    const s = startingState();
    const m = hardBot.pickMove(s, "0");
    expect(m.row).toBe(5);
    expect(m.col).toBe(5);
  });
  it("hardBot picks legal after a few moves", () => {
    let s = startingState();
    s = applyMove(s, { row: 5, col: 5 });
    s = applyMove(s, { row: 4, col: 6 });
    const m = hardBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.row === m.row && x.col === m.col)).toBe(true);
  });
});
