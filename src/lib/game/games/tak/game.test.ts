import { describe, expect, it } from "vitest";
import {
  STONES_PER_PLAYER,
  TOTAL_CELLS,
  applyMove,
  cellIdx,
  checkResult,
  findRoad,
  game,
  isLegalMove,
  legalMoves,
  opposite,
  startingState,
  type TakState,
} from "./game";

describe("tak — setup", () => {
  it("empty 5×5, 21 stones each, P0 to move", () => {
    const s = startingState();
    expect(s.cells.length).toBe(TOTAL_CELLS);
    expect(s.cells.every((c) => c === null)).toBe(true);
    expect(s.stonesLeft).toEqual({ "0": STONES_PER_PLAYER, "1": STONES_PER_PLAYER });
    expect(s.turn).toBe("0");
  });
  it("opposite flips player", () => {
    expect(opposite("0")).toBe("1");
    expect(opposite("1")).toBe("0");
  });
});

describe("tak — placement", () => {
  it("placing a flat occupies the cell, decrements supply, flips turn", () => {
    const s = applyMove(startingState(), { to: { row: 0, col: 0 }, kind: "F" });
    expect(s.cells[cellIdx(0, 0)]).toEqual({ side: "0", kind: "F" });
    expect(s.stonesLeft["0"]).toBe(STONES_PER_PLAYER - 1);
    expect(s.turn).toBe("1");
  });
  it("isLegalMove rejects occupied cells + bad kind + out-of-range", () => {
    const s = applyMove(startingState(), { to: { row: 0, col: 0 }, kind: "F" });
    expect(isLegalMove(s, { to: { row: 0, col: 0 }, kind: "F" })).toBe(false); // occupied
    expect(isLegalMove(s, { to: { row: -1, col: 0 }, kind: "F" })).toBe(false);
    expect(isLegalMove(s, { to: { row: 0, col: 1 }, kind: "X" as unknown as "F" })).toBe(false);
  });
  it("legalMoves enumerates both flat AND wall for each empty cell", () => {
    const s = startingState();
    expect(legalMoves(s).length).toBe(25 * 2);
  });
});

describe("tak — road detection", () => {
  it("five flats across row 0 win for P0 (top↔bottom orientation: not yet — that's left↔right)", () => {
    let s = startingState();
    // To form a left↔right road on row 0 we need (0,0)..(0,4) all P0 flats.
    const seq: Array<[number, number, "F"]> = [
      [0, 0, "F"], [4, 4, "F"], // P0, P1
      [0, 1, "F"], [4, 3, "F"],
      [0, 2, "F"], [4, 2, "F"],
      [0, 3, "F"], [4, 1, "F"],
      [0, 4, "F"], // P0 completes left↔right road on row 0
    ];
    for (const [r, c, k] of seq) s = applyMove(s, { to: { row: r, col: c }, kind: k });
    const r = checkResult(s);
    expect(r.status).toBe("win");
    if (r.status === "win") expect(r.winner).toBe("0");
  });

  it("walls do NOT count for road", () => {
    let s = startingState();
    // P0 places walls on row 0 instead of flats — no road.
    const seq: Array<[number, number, "F" | "W"]> = [
      [0, 0, "W"], [4, 4, "F"],
      [0, 1, "W"], [4, 3, "F"],
      [0, 2, "W"], [4, 2, "F"],
      [0, 3, "W"], [4, 1, "F"],
      [0, 4, "W"], // P0 row 0 is all walls
    ];
    for (const [r, c, k] of seq) s = applyMove(s, { to: { row: r, col: c }, kind: k });
    expect(checkResult(s).status).toBe("ongoing");
  });

  it("findRoad returns the path of cells for a winning side", () => {
    const cells: TakState["cells"] = Array(25).fill(null);
    for (let c = 0; c < 5; c++) cells[cellIdx(0, c)] = { side: "0", kind: "F" };
    const path = findRoad(cells, "0");
    expect(path).not.toBeNull();
    expect(path?.length).toBeGreaterThanOrEqual(5);
  });

  it("an opponent wall in the middle blocks our road", () => {
    let s = startingState();
    // P0 plays (0,0),(0,1),(0,3),(0,4); P1 places a wall at (0,2) blocking the middle.
    const seq: Array<[number, number, "F" | "W"]> = [
      [0, 0, "F"], [0, 2, "W"],
      [0, 1, "F"], [4, 4, "F"],
      [0, 3, "F"], [4, 3, "F"],
      [0, 4, "F"], // No road — (0,2) is a wall.
    ];
    for (const [r, c, k] of seq) s = applyMove(s, { to: { row: r, col: c }, kind: k });
    expect(checkResult(s).status).toBe("ongoing");
  });
});

describe("tak — termination", () => {
  it("draw when both players are out of stones with no road", () => {
    const cells: TakState["cells"] = Array(25).fill(null);
    // Fill the board with alternating walls so no road forms.
    for (let i = 0; i < 25; i++) {
      cells[i] = { side: i % 2 === 0 ? "0" : "1", kind: "W" };
    }
    const s: TakState = {
      cells,
      turn: "0",
      stonesLeft: { "0": 0, "1": 0 },
      lastMove: null,
    };
    expect(checkResult(s).status).toBe("draw");
  });
});

describe("tak — boardgame.io", () => {
  it("setup matches starting state", () => {
    const initial = (game.setup as () => TakState)();
    expect(initial.turn).toBe("0");
    expect(initial.stonesLeft).toEqual({ "0": STONES_PER_PLAYER, "1": STONES_PER_PLAYER });
  });
});
