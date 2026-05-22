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

describe("mediumBot — open-three trap defense (regression)", () => {
  // The bug that motivated the medium-bot upgrade: at the position
  // below, yellow has just played col 2 creating an open three on the
  // bottom row (cells 2/3/4 filled). Bot is red, playing as p2.
  // BOTH col 1 and col 5 are winning threats for yellow next turn —
  // bot can only block one. Old medium bot (depth 3, no heuristic)
  // missed this entirely and stacked col 3 because all paths scored
  // 0 at leaves. New medium bot (depth 4 + heuristic) must choose
  // col 1 or col 5, not col 3.
  //
  // (Yes, both blocks lose to the OTHER end — yellow has a forced
  // mate. But picking col 1/5 stalls one tempo, picking col 3
  // hands yellow the win immediately and looks idiotic to anyone
  // watching the move-by-move.)
  it("blocks the open-three even when both ends are winning for opponent", () => {
    let b = emptyBoard();
    // The recorded production sequence up to bot's move 5:
    b = applyMove(b, 3, 1); // y col 3
    b = applyMove(b, 3, 2); // r col 3 (stack)
    b = applyMove(b, 4, 1); // y col 4
    b = applyMove(b, 3, 2); // r col 3 (stack again)
    b = applyMove(b, 2, 1); // y col 2 — OPEN THREE
    // Bot now plays p2. Must NOT pick col 3 (the worst move).
    const col = mediumBot.pickMove(stateOf(b), "1");
    expect([1, 5]).toContain(col);
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
