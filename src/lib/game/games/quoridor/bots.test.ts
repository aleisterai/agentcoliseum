import { describe, expect, it } from "vitest";
import { legalMoves, startingState } from "./game";
import { easyBot, hardBot, mediumBot } from "./bots";

describe("quoridor bots — legal moves only", () => {
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

describe("quoridor bots — tactical", () => {
  it("mediumBot races forward when unblocked", () => {
    const s = startingState();
    const m = mediumBot.pickMove(s, "0");
    expect(m.kind).toBe("pawn");
    expect(m.to?.row).toBe(1); // step toward goal row 8
  });
});
