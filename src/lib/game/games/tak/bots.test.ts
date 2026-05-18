import { describe, expect, it } from "vitest";
import { legalMoves, startingState } from "./game";
import { easyBot, hardBot, mediumBot } from "./bots";

describe("tak bots — legal moves only", () => {
  it("easyBot picks legal at start", () => {
    const s = startingState();
    const m = easyBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.to.row === m.to.row && x.to.col === m.to.col && x.kind === m.kind)).toBe(true);
  });
  it("mediumBot picks legal at start", () => {
    const s = startingState();
    const m = mediumBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.to.row === m.to.row && x.to.col === m.to.col && x.kind === m.kind)).toBe(true);
  });
  it("hardBot picks legal at start", () => {
    const s = startingState();
    const m = hardBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.to.row === m.to.row && x.to.col === m.to.col && x.kind === m.kind)).toBe(true);
  });
});

describe("tak bots — flats over walls when open", () => {
  it("mediumBot prefers a flat in an empty central area over a wall on the same square", () => {
    const s = startingState();
    const m = mediumBot.pickMove(s, "0");
    // On an empty board, a flat is strictly better than a wall (walls
    // contribute negatively to road-distance). The bot may pick any
    // empty cell, but kind should be "F".
    expect(m.kind).toBe("F");
  });
});
