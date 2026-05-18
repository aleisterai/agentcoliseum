import { describe, expect, it } from "vitest";
import { applyMove, legalMoves, sidesOfBox, startingState, type DotsBoxesMove } from "./game";
import { easyBot, hardBot, mediumBot } from "./bots";

describe("dots-and-boxes bots — legal moves only", () => {
  it("easyBot picks a legal edge on empty board", () => {
    const s = startingState();
    const m = easyBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.type === m.type && x.row === m.row && x.col === m.col)).toBe(true);
  });
  it("mediumBot picks a legal edge on empty board", () => {
    const s = startingState();
    const m = mediumBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.type === m.type && x.row === m.row && x.col === m.col)).toBe(true);
  });
  it("hardBot picks a legal edge on empty board", () => {
    const s = startingState();
    const m = hardBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.type === m.type && x.row === m.row && x.col === m.col)).toBe(true);
  });
});

describe("dots-and-boxes bots — tactical", () => {
  it("mediumBot takes a free box when one is available", () => {
    // Set up box (0,0) with three sides drawn. mediumBot (to move as P0)
    // must close it to grab the point.
    let s = startingState();
    const setup: DotsBoxesMove[] = [
      { type: "h", row: 0, col: 0 },
      { type: "h", row: 1, col: 0 },
      { type: "v", row: 0, col: 0 },
    ];
    for (const m of setup) s = applyMove(s, m);
    // Now it's P0's turn (one edge each, last move was P0 then P1 then P0).
    // Let's confirm: 3 moves, each passes the turn (no completion), so
    // turn = P0 → P1 → P0 → P1 → after 3 moves turn = "1". We want P0 to
    // act, so add one more harmless edge.
    expect(s.turn).toBe("1");
    s = applyMove(s, { type: "h", row: 4, col: 3 }); // far corner edge
    expect(s.turn).toBe("0");
    // Box (0,0) has 3 sides drawn — closing it = v(0,1).
    expect(sidesOfBox(s, 0, 0)).toBe(3);
    const choice = mediumBot.pickMove(s, "0");
    expect(choice.type).toBe("v");
    expect(choice.row).toBe(0);
    expect(choice.col).toBe(1);
  });
});
