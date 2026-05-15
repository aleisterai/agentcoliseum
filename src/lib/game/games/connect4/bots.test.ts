import { describe, expect, it } from "vitest";
import { applyMove, checkResult, emptyBoard, isLegalMove } from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";

function stateOf(board: number[][]) {
  return { board, lastMove: null };
}

describe("easyBot", () => {
  it("picks legal moves only", () => {
    const s = stateOf(emptyBoard());
    for (let i = 0; i < 20; i++) {
      const col = easyBot.pickMove(s, "0");
      expect(isLegalMove(s.board, col)).toBe(true);
    }
  });
});

describe("mediumBot", () => {
  it("blocks an immediate horizontal three-in-a-row", () => {
    // Player 2 (O) has three in a row. The bot plays for player 0 (X = 1) and
    // must block at column 3 to prevent O from winning next move.
    let b = emptyBoard();
    b = applyMove(b, 0, 2);
    b = applyMove(b, 1, 2);
    b = applyMove(b, 2, 2);
    const col = mediumBot.pickMove(stateOf(b), "0");
    expect(col).toBe(3);
  });

  it("plays a winning move when one is available", () => {
    let b = emptyBoard();
    b = applyMove(b, 0, 1);
    b = applyMove(b, 1, 1);
    b = applyMove(b, 2, 1);
    const col = mediumBot.pickMove(stateOf(b), "0");
    expect(col).toBe(3);
  });
});

describe("hardBot vs easyBot — deterministic outcome", () => {
  it("hard reliably does not lose to easy in a self-play game", () => {
    // Hard plays X (player 0 = 1), Easy plays O (player 1 = 2).
    let b = emptyBoard();
    let toMove: 1 | 2 = 1;
    let movesPlayed = 0;
    while (movesPlayed < 42) {
      const pickerForX = toMove === 1 ? hardBot : easyBot;
      const pid: "0" | "1" = toMove === 1 ? "0" : "1";
      const col = pickerForX.pickMove(stateOf(b), pid);
      b = applyMove(b, col, toMove);
      const r = checkResult(b);
      if (r.status !== "ongoing") {
        if (r.status === "win") expect(r.winner).toBe(1);
        return;
      }
      toMove = toMove === 1 ? 2 : 1;
      movesPlayed++;
    }
    // 42 moves played with no win = draw, which is also acceptable.
  });
});
