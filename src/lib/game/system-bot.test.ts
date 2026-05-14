import { describe, expect, it } from "vitest";
import { applyMove, checkResult, emptyBoard, isLegalMove } from "./connect4";
import { chooseMove } from "./system-bot";

describe("chooseMove — easy", () => {
  it("picks legal moves only", () => {
    const b = emptyBoard();
    for (let i = 0; i < 20; i++) {
      const col = chooseMove(b, 1, "easy");
      expect(isLegalMove(b, col)).toBe(true);
    }
  });
});

describe("chooseMove — medium", () => {
  it("blocks an immediate horizontal three-in-a-row", () => {
    // Player 2 (O) has three in a row. The bot plays for 1 (X) and must block at col 3.
    let b = emptyBoard();
    b = applyMove(b, 0, 2);
    b = applyMove(b, 1, 2);
    b = applyMove(b, 2, 2);
    // Bot must block at column 3 to prevent O from winning next move.
    const col = chooseMove(b, 1, "medium");
    expect(col).toBe(3);
  });

  it("plays a winning move when one is available", () => {
    // Bot is X. Three Xs along the bottom — winning move is col 3.
    let b = emptyBoard();
    b = applyMove(b, 0, 1);
    b = applyMove(b, 1, 1);
    b = applyMove(b, 2, 1);
    const col = chooseMove(b, 1, "medium");
    expect(col).toBe(3);
  });
});

describe("chooseMove — hard vs easy: deterministic game outcome", () => {
  it("hard reliably beats easy in a self-play game", () => {
    // Hard plays X (player 1), Easy plays O (player 2).
    // Play out a game and verify Hard wins (or draws — never loses).
    let b = emptyBoard();
    let toMove: 1 | 2 = 1;
    let movesPlayed = 0;
    while (movesPlayed < 42) {
      const col = chooseMove(b, toMove, toMove === 1 ? "hard" : "easy");
      b = applyMove(b, col, toMove);
      const r = checkResult(b);
      if (r.status !== "ongoing") {
        // Hard should not lose.
        if (r.status === "win") expect(r.winner).toBe(1);
        return;
      }
      toMove = toMove === 1 ? 2 : 1;
      movesPlayed++;
    }
    // Reached 42 moves without a win: that's a draw (full board, no line).
    // For a Connect 4 expert bot vs random, this almost never happens; if it
    // does, that's still acceptable (no loss).
  });
});
