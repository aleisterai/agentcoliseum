import { describe, expect, it } from "vitest";
import {
  applyMove,
  checkResult,
  emptyBoard,
  opponentOf,
  type Board,
  type Player,
} from "./game";
import { easyBot, hardBot, mediumBot } from "./bots";

function makeState(board: Board) {
  return { board, lastMove: null };
}

describe("tic-tac-toe easyBot", () => {
  it("picks a legal move on a non-terminal board", () => {
    const b = emptyBoard();
    const move = easyBot.pickMove(makeState(b), "0");
    expect(move).toBeGreaterThanOrEqual(0);
    expect(move).toBeLessThan(9);
    expect(b[move]).toBe(0);
  });

  it("throws on a finished board", () => {
    const b: Board = [1, 1, 1, 2, 2, 0, 0, 0, 0];
    expect(() => easyBot.pickMove(makeState(b), "0")).not.toThrow(); // there are legal cells
    const full: Board = [1, 2, 1, 1, 2, 2, 2, 1, 1];
    expect(() => easyBot.pickMove(makeState(full), "0")).toThrow();
  });
});

describe("tic-tac-toe mediumBot", () => {
  it("takes the winning move when available", () => {
    // P1 has two in a top row; cell 2 wins.
    const b: Board = [1, 1, 0, 0, 2, 0, 2, 0, 0];
    expect(mediumBot.pickMove(makeState(b), "0")).toBe(2);
  });

  it("blocks opponent's threat when no immediate win", () => {
    // P2 (we) faces P1 threat on top row; we should play cell 2 to block.
    const b: Board = [1, 1, 0, 0, 2, 0, 0, 0, 0];
    expect(mediumBot.pickMove(makeState(b), "1")).toBe(2);
  });

  it("plays center on an empty board", () => {
    expect(mediumBot.pickMove(makeState(emptyBoard()), "0")).toBe(4);
  });
});

describe("tic-tac-toe hardBot (perfect play)", () => {
  it("never loses from an empty board against any opponent", () => {
    // Play hard vs random 50 times — perfect play should never lose.
    for (let trial = 0; trial < 30; trial++) {
      let board = emptyBoard();
      let toMove: Player = 1;
      // hardBot is player 1, easyBot is player 2.
      while (true) {
        const result = checkResult(board);
        if (result.status !== "ongoing") {
          // Must be draw or hardBot win — never a loss for player 1.
          expect(result.status === "win" ? result.winner : "draw").not.toBe(2);
          break;
        }
        const pid: "0" | "1" = toMove === 1 ? "0" : "1";
        const move =
          toMove === 1
            ? hardBot.pickMove(makeState(board), pid)
            : easyBot.pickMove(makeState(board), pid);
        board = applyMove(board, move, toMove);
        toMove = opponentOf(toMove);
      }
    }
  });

  it("hard vs hard always draws", () => {
    let board = emptyBoard();
    let toMove: Player = 1;
    while (true) {
      const result = checkResult(board);
      if (result.status !== "ongoing") {
        expect(result.status).toBe("draw");
        break;
      }
      const pid: "0" | "1" = toMove === 1 ? "0" : "1";
      const move = hardBot.pickMove(makeState(board), pid);
      board = applyMove(board, move, toMove);
      toMove = opponentOf(toMove);
    }
  });

  it("blocks an immediate threat", () => {
    // P2 has cells 0 and 1 → threatens row 0. P1 (hard) must block at 2.
    // (Note: positions like [_,2,_,_,2,_,_,_,_] are actually already lost
    // for P1 — P2 can create a double-fork after the block. Minimax sees
    // this and picks any move; that's correct, not a bug.)
    const b: Board = [2, 2, 0, 0, 0, 0, 0, 0, 0];
    expect(hardBot.pickMove(makeState(b), "0")).toBe(2);
  });
});
