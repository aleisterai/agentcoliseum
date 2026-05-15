import { describe, expect, it } from "vitest";
import {
  applyMove,
  emptyBoard,
  indexOf,
  legalMoves,
  startingState,
  type CheckersState,
} from "./game";
import { easyBot, hardBot, mediumBot } from "./bots";

describe("checkers bots — legal moves only", () => {
  it("easyBot picks legal on the starting board", () => {
    const s = startingState();
    const m = easyBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.from[0] === m.from[0] && x.from[1] === m.from[1])).toBe(true);
  });

  it("mediumBot picks legal on the starting board", () => {
    const s = startingState();
    const m = mediumBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.from[0] === m.from[0] && x.from[1] === m.from[1])).toBe(true);
  });

  it("hardBot picks legal on the starting board", () => {
    const s = startingState();
    const m = hardBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.from[0] === m.from[0] && x.from[1] === m.from[1])).toBe(true);
  });
});

describe("checkers bots — tactical", () => {
  it("mediumBot prefers a capture when one exists", () => {
    // Force a single-capture position with a sentinel king on each side
    // (so the no_pieces termination doesn't fire).
    const board = emptyBoard();
    board[indexOf(7, 0)] = "Wk";
    board[indexOf(0, 7)] = "Bk";
    board[indexOf(5, 2)] = "Wm";
    board[indexOf(4, 3)] = "Bm";
    const state: CheckersState = {
      board,
      turn: "W",
      halfmoveClock: 0,
      lastMove: null,
    };
    const m = mediumBot.pickMove(state, "0");
    // Must be a jump from (5,2) landing on (3,4).
    expect(m.from).toEqual([5, 2]);
    expect(m.path[m.path.length - 1]).toEqual([3, 4]);
    // Verify it actually captures.
    const next = applyMove(state, m);
    expect(next.board[indexOf(4, 3)]).toBe("");
  });

  it("hardBot extends a double-jump opportunity", () => {
    // Same as the chain test in game.test, but check that hardBot picks the
    // longest chain (depth-1 wouldn't suffice for some positions; depth-6
    // gives plenty of headroom).
    const board = emptyBoard();
    board[indexOf(7, 0)] = "Wk";
    board[indexOf(0, 7)] = "Bk";
    board[indexOf(5, 2)] = "Wm";
    board[indexOf(4, 3)] = "Bm";
    board[indexOf(2, 3)] = "Bm";
    const state: CheckersState = {
      board,
      turn: "W",
      halfmoveClock: 0,
      lastMove: null,
    };
    const m = hardBot.pickMove(state, "0");
    expect(m.path.length).toBe(2); // chain of 2
  });
});
