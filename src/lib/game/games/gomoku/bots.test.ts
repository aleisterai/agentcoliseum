import { describe, expect, it } from "vitest";
import {
  applyMove,
  emptyBoard,
  indexOf,
  legalMoves,
  startingState,
  type GomokuState,
} from "./game";
import { easyBot, hardBot, mediumBot } from "./bots";

describe("gomoku bots — legal moves only", () => {
  it("easyBot picks legal on empty board", () => {
    const s = startingState();
    const m = easyBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.row === m.row && x.col === m.col)).toBe(true);
  });
  it("mediumBot picks legal on empty board", () => {
    const s = startingState();
    const m = mediumBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.row === m.row && x.col === m.col)).toBe(true);
  });
  it("hardBot picks legal on empty board", () => {
    const s = startingState();
    const m = hardBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.row === m.row && x.col === m.col)).toBe(true);
  });
});

describe("gomoku bots — tactical", () => {
  it("mediumBot blocks an open-4 threat (must-block)", () => {
    // Black has 4 in a row on row 7, cols 3..6, both ends open.
    // White (to move) MUST block at (7,2) or (7,7) — either wins next
    // turn for Black otherwise.
    const board = emptyBoard();
    for (const c of [3, 4, 5, 6]) board[indexOf(7, c)] = "B";
    const state: GomokuState = {
      board,
      turn: "W",
      lastMove: { row: 7, col: 6, player: "B" },
      moveCount: 4,
    };
    const m = mediumBot.pickMove(state, "1");
    const isBlock =
      (m.row === 7 && (m.col === 2 || m.col === 7));
    expect(isBlock).toBe(true);
  });

  it("hardBot takes an immediate win when one exists", () => {
    // Black has 4 in a row on row 7, cols 3..6 — Black to move, plays (7,7)
    // or (7,2) to win.
    const board = emptyBoard();
    for (const c of [3, 4, 5, 6]) board[indexOf(7, c)] = "B";
    const state: GomokuState = {
      board,
      turn: "B",
      lastMove: { row: 7, col: 6, player: "B" },
      moveCount: 4,
    };
    const m = hardBot.pickMove(state, "0");
    const isWin = (m.row === 7 && (m.col === 7 || m.col === 2));
    expect(isWin).toBe(true);
  });
});

void applyMove;
