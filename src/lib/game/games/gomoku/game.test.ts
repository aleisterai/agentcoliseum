import { describe, expect, it } from "vitest";
import {
  SIZE,
  WIN_LEN,
  applyMove,
  checkResult,
  emptyBoard,
  game,
  indexOf,
  isLegalMove,
  legalMoves,
  opposite,
  startingState,
  type GomokuState,
} from "./game";

describe("gomoku engine — setup", () => {
  it("starting state: empty 15×15 board, Black to move", () => {
    const s = startingState();
    expect(s.board.length).toBe(SIZE * SIZE);
    expect(s.board.every((c) => c === "")).toBe(true);
    expect(s.turn).toBe("B");
    expect(s.moveCount).toBe(0);
  });

  it("opposite flips side", () => {
    expect(opposite("B")).toBe("W");
    expect(opposite("W")).toBe("B");
  });

  it("starting position has 225 legal moves", () => {
    expect(legalMoves(startingState()).length).toBe(225);
  });
});

describe("gomoku engine — placement", () => {
  it("applyMove places a stone and flips the turn", () => {
    const s = startingState();
    const next = applyMove(s, { row: 7, col: 7 });
    expect(next.board[indexOf(7, 7)]).toBe("B");
    expect(next.turn).toBe("W");
    expect(next.moveCount).toBe(1);
    expect(next.lastMove).toEqual({ row: 7, col: 7, player: "B" });
  });

  it("isLegalMove rejects occupied + out-of-range squares", () => {
    const s = applyMove(startingState(), { row: 0, col: 0 });
    expect(isLegalMove(s.board, 0, 0)).toBe(false);
    expect(isLegalMove(s.board, 14, 14)).toBe(true);
    expect(isLegalMove(s.board, -1, 0)).toBe(false);
    expect(isLegalMove(s.board, 0, 15)).toBe(false);
  });

  it("applyMove throws on illegal placements", () => {
    const s = applyMove(startingState(), { row: 5, col: 5 });
    expect(() => applyMove(s, { row: 5, col: 5 })).toThrow();
  });
});

describe("gomoku engine — win detection", () => {
  it("five in a row horizontally → win for that side", () => {
    let s = startingState();
    // Black plays five in a row on row 7: cols 5..9.
    // White plays harmlessly elsewhere between moves.
    const seq: Array<[number, number]> = [
      [7, 5], [0, 0], [7, 6], [0, 1], [7, 7], [0, 2], [7, 8], [0, 3], [7, 9],
    ];
    for (const [r, c] of seq) s = applyMove(s, { row: r, col: c });
    const result = checkResult(s);
    expect(result.status).toBe("win");
    if (result.status === "win") {
      expect(result.winner).toBe("B");
      expect(result.line.length).toBe(WIN_LEN);
    }
  });

  it("five in a row diagonally → win", () => {
    let s = startingState();
    // Diagonal: (3,3)..(7,7) for Black; harmless White moves between.
    const seq: Array<[number, number]> = [
      [3, 3], [0, 0], [4, 4], [0, 1], [5, 5], [0, 2], [6, 6], [0, 3], [7, 7],
    ];
    for (const [r, c] of seq) s = applyMove(s, { row: r, col: c });
    const r = checkResult(s);
    expect(r.status).toBe("win");
    if (r.status === "win") expect(r.winner).toBe("B");
  });

  it("six in a row (overline) also counts as a win", () => {
    let s = startingState();
    const seq: Array<[number, number]> = [
      [7, 4], [0, 0],
      [7, 5], [0, 1],
      [7, 6], [0, 2],
      [7, 7], [0, 3],
      [7, 8], [0, 4],
      [7, 9],
    ];
    for (const [r, c] of seq) s = applyMove(s, { row: r, col: c });
    const r = checkResult(s);
    expect(r.status).toBe("win");
  });

  it("ongoing when there's no five-in-a-row", () => {
    const s = applyMove(startingState(), { row: 7, col: 7 });
    expect(checkResult(s).status).toBe("ongoing");
  });

  it("draw if board is full with no winner — constructed scenario", () => {
    // Building a 15x15 no-win board would be impractical, so we
    // construct a tiny scenario: fill the board with alternating B/W
    // in a pattern that has no 5-in-a-row. The fastest way is to fill
    // a hand-crafted no-win pattern via direct state.
    const board = Array(225).fill("") as ("B" | "W" | "")[];
    // BWBWBWBW… pattern fills rows; alternating per row to break vertical
    // and diagonal runs. Some long row runs are unavoidable in
    // alternating fill, BUT we want no 5-in-a-row.
    // Use: stripe pattern row r col c = (r + c) % 2 === 0 ? "B" : "W"
    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 15; c++) {
        board[indexOf(r, c)] = (r + c) % 2 === 0 ? "B" : "W";
      }
    }
    // Stripe has no 5-in-a-row of one color (alternating).
    const s: GomokuState = {
      board: board as unknown as GomokuState["board"],
      turn: "B",
      lastMove: { row: 14, col: 14, player: "W" },
      moveCount: 225,
    };
    const r = checkResult(s);
    expect(r.status).toBe("draw");
  });
});

describe("gomoku boardgame.io", () => {
  it("setup returns an empty starting state", () => {
    const initial = (game.setup as () => GomokuState)();
    expect(initial.turn).toBe("B");
    expect(initial.board.length).toBe(225);
  });
  it("endIf maps winner to playerID", () => {
    let s = startingState();
    const seq: Array<[number, number]> = [
      [7, 5], [0, 0], [7, 6], [0, 1], [7, 7], [0, 2], [7, 8], [0, 3], [7, 9],
    ];
    for (const [r, c] of seq) s = applyMove(s, { row: r, col: c });
    const endIf = game.endIf as (ctx: { G: GomokuState }) => unknown;
    expect(endIf({ G: s })).toEqual({ winner: "0" });
  });
});
