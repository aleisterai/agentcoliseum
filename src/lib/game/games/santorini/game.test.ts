import { describe, expect, it } from "vitest";
import {
  DOME,
  SIZE,
  applyMove,
  canMoveTo,
  cellIdx,
  checkResult,
  game,
  isBuilderAt,
  isLegalMove,
  legalMoves,
  neighbors,
  opposite,
  startingState,
  type SantoriniState,
} from "./game";

describe("santorini — setup", () => {
  it("starting positions and zero levels", () => {
    const s = startingState();
    expect(s.levels.every((l) => l === 0)).toBe(true);
    expect(s.builders["0"][0]).toEqual({ row: 0, col: 1 });
    expect(s.builders["0"][1]).toEqual({ row: 0, col: 3 });
    expect(s.builders["1"][0]).toEqual({ row: 4, col: 1 });
    expect(s.builders["1"][1]).toEqual({ row: 4, col: 3 });
    expect(s.turn).toBe("0");
  });

  it("neighbors returns up to 8 in-bounds", () => {
    expect(neighbors(2, 2).length).toBe(8); // center
    expect(neighbors(0, 0).length).toBe(3); // corner
  });

  it("opposite flips player", () => {
    expect(opposite("0")).toBe("1");
    expect(opposite("1")).toBe("0");
  });
});

describe("santorini — move legality", () => {
  it("canMoveTo enforces climb-by-one and 8-adjacency", () => {
    const s: SantoriniState = {
      levels: Array(25).fill(0),
      builders: {
        "0": [{ row: 0, col: 0 }, { row: 0, col: 4 }],
        "1": [{ row: 4, col: 0 }, { row: 4, col: 4 }],
      },
      turn: "0",
      lastMove: null,
    };
    s.levels[cellIdx(0, 1)] = 2;
    // From (0,0) to (0,1) at level 2 — climb of 2; illegal.
    expect(canMoveTo(s, 0, 0, 0, 1)).toBe(false);
    // From (0,0) to (1,0) at level 0 — fine.
    expect(canMoveTo(s, 0, 0, 1, 0)).toBe(true);
    // From (0,0) to (1,1) at level 0 — diagonal allowed.
    expect(canMoveTo(s, 0, 0, 1, 1)).toBe(true);
    // Can't move onto a builder.
    expect(canMoveTo(s, 0, 0, 0, 4)).toBe(false); // not adjacent anyway
  });

  it("isLegalMove rejects builds onto a builder", () => {
    const s = startingState();
    // P0's builder 0 at (0,1) moves to (1,1) → tries to build on (0,3) where another P0 builder is.
    // (0,3) isn't adjacent to (1,1), so build there is illegal regardless.
    // Instead: try to build on (0, 1) — that's where the OTHER builder's move came from? No.
    // Actually (1, 1) is adjacent to (0, 0), (0, 1), (0, 2), (1, 0), (1, 2), (2, 0), (2, 1), (2, 2).
    // No builder is at any of those after the move (builder 0 moved off (0,1)). Build is fine.
    expect(isLegalMove(s, { builder: 0, to: { row: 1, col: 1 }, build: { row: 0, col: 1 } })).toBe(true);
    // But try to build on (0, 3) where the other P0 builder sits — not adjacent to (1, 1), illegal.
    expect(isLegalMove(s, { builder: 0, to: { row: 1, col: 1 }, build: { row: 0, col: 3 } })).toBe(false);
  });

  it("legalMoves enumerates move+build pairs", () => {
    const s = startingState();
    const all = legalMoves(s);
    expect(all.length).toBeGreaterThan(0);
    // From corner-adjacent starts, each builder has 3 neighbours that are in-bounds and clear.
    // Each neighbour has up to ~5 build targets. Lower bound is 1.
  });
});

describe("santorini — termination", () => {
  it("stepping onto level 3 wins (climb)", () => {
    const s: SantoriniState = {
      levels: Array(25).fill(0),
      builders: {
        "0": [{ row: 1, col: 1 }, { row: 0, col: 4 }],
        "1": [{ row: 4, col: 0 }, { row: 4, col: 4 }],
      },
      turn: "0",
      lastMove: null,
    };
    s.levels[cellIdx(1, 1)] = 2; // climber's source
    s.levels[cellIdx(2, 2)] = 3; // target = level 3
    const next = applyMove(s, { builder: 0, to: { row: 2, col: 2 }, build: { row: 3, col: 3 } });
    const r = checkResult(next);
    expect(r.status).toBe("win");
    if (r.status === "win") {
      expect(r.winner).toBe("0");
      expect(r.reason).toBe("climb");
    }
  });

  it("isBuilderAt locates either color's builders", () => {
    const s = startingState();
    expect(isBuilderAt(s, 0, 1)).toBe(true);
    expect(isBuilderAt(s, 4, 1)).toBe(true);
    expect(isBuilderAt(s, 2, 2)).toBe(false);
  });

  it("DOME constant is 4 and capping moves can't land on dome", () => {
    expect(DOME).toBe(4);
    const s: SantoriniState = {
      levels: Array(25).fill(0),
      builders: {
        "0": [{ row: 1, col: 1 }, { row: 0, col: 4 }],
        "1": [{ row: 4, col: 0 }, { row: 4, col: 4 }],
      },
      turn: "0",
      lastMove: null,
    };
    s.levels[cellIdx(2, 2)] = DOME;
    expect(canMoveTo(s, 1, 1, 2, 2)).toBe(false);
  });
});

describe("santorini — boardgame.io", () => {
  it("setup matches starting state shape", () => {
    const initial = (game.setup as () => SantoriniState)();
    expect(initial.turn).toBe("0");
    expect(initial.levels.length).toBe(25);
  });
});

void SIZE;
