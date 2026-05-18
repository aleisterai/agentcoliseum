import { describe, expect, it } from "vitest";
import {
  SIZE,
  TOTAL_CELLS,
  applyMove,
  checkResult,
  emptyBoard,
  game,
  indexOf,
  isLegalMove,
  legalMoves,
  neighborsOf,
  opposite,
  startingState,
  type HexState,
} from "./game";

describe("hex — setup", () => {
  it("starting state: empty 11x11, Red to move", () => {
    const s = startingState();
    expect(s.board.length).toBe(TOTAL_CELLS);
    expect(s.board.every((c) => c === "")).toBe(true);
    expect(s.turn).toBe("R");
    expect(s.moveCount).toBe(0);
  });
  it("opposite flips side", () => {
    expect(opposite("R")).toBe("B");
    expect(opposite("B")).toBe("R");
  });
  it("neighborsOf returns up to 6 valid in-bounds neighbours", () => {
    // Corner: (0, 0) has neighbours (0, 1) and (1, 0) — but also
    // diagonal-up-left (-1, 1) etc out of bounds, so only 2 here? Let's
    // check what the deltas give us at (0,0):
    //   (-1, 0) out, (-1, 1) out, (0, -1) out, (0, 1) in, (1, -1) out, (1, 0) in
    // → 2 neighbours.
    expect(neighborsOf(0, 0).length).toBe(2);
    // Center cell has all 6.
    expect(neighborsOf(5, 5).length).toBe(6);
  });
});

describe("hex — placement", () => {
  it("placing a stone occupies the cell and flips turn", () => {
    const s = applyMove(startingState(), { row: 5, col: 5 });
    expect(s.board[indexOf(5, 5)]).toBe("R");
    expect(s.turn).toBe("B");
    expect(s.moveCount).toBe(1);
  });
  it("isLegalMove rejects occupied + out-of-range", () => {
    let s = startingState();
    expect(isLegalMove(s.board, 0, 0)).toBe(true);
    s = applyMove(s, { row: 0, col: 0 });
    expect(isLegalMove(s.board, 0, 0)).toBe(false);
    expect(isLegalMove(s.board, -1, 0)).toBe(false);
    expect(isLegalMove(s.board, 0, 99)).toBe(false);
  });
  it("legalMoves enumerates all empty cells", () => {
    expect(legalMoves(startingState()).length).toBe(121);
  });
});

describe("hex — win detection", () => {
  it("Red wins by connecting top to bottom", () => {
    // Build a column of Red stones from row 0 to row 10 in column 5.
    // (Verify by checking actual hex adjacency: (r, 5) ↔ (r+1, 5)? Yes —
    // neighborDelta (1, 0) is in-bounds and shifts by one row keeping
    // the column. So a straight column works.)
    const board = emptyBoard();
    for (let r = 0; r < SIZE; r++) board[indexOf(r, 5)] = "R";
    const state: HexState = {
      board,
      turn: "B",
      lastMove: { row: 10, col: 5, player: "R" },
      moveCount: 11,
    };
    const r = checkResult(state);
    expect(r.status).toBe("win");
    if (r.status === "win") {
      expect(r.winner).toBe("R");
      expect(r.line.length).toBe(SIZE);
    }
  });

  it("Blue wins by connecting left to right", () => {
    // A row of Blue stones from col 0 to col 10 in row 5.
    const board = emptyBoard();
    for (let c = 0; c < SIZE; c++) board[indexOf(5, c)] = "B";
    const state: HexState = {
      board,
      turn: "R",
      lastMove: { row: 5, col: 10, player: "B" },
      moveCount: 11,
    };
    const r = checkResult(state);
    expect(r.status).toBe("win");
    if (r.status === "win") {
      expect(r.winner).toBe("B");
    }
  });

  it("ongoing when no chain exists", () => {
    const s = applyMove(startingState(), { row: 5, col: 5 });
    expect(checkResult(s).status).toBe("ongoing");
  });
});

describe("hex — boardgame.io", () => {
  it("setup returns the starting state", () => {
    const initial = (game.setup as () => HexState)();
    expect(initial.turn).toBe("R");
    expect(initial.board.length).toBe(121);
  });
});
