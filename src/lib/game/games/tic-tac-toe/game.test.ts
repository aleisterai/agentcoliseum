import { describe, expect, it } from "vitest";
import {
  CELLS,
  LINES,
  applyMove,
  checkResult,
  emptyBoard,
  game,
  isLegalMove,
  legalMoves,
  opponentOf,
  renderBoard,
  rowColOf,
  indexOf,
  type Board,
} from "./game";

describe("tic-tac-toe pure engine", () => {
  it("emptyBoard is 9 zeros", () => {
    const b = emptyBoard();
    expect(b).toHaveLength(CELLS);
    expect(b.every((c) => c === 0)).toBe(true);
  });

  it("legalMoves returns every empty cell, in order", () => {
    const b = emptyBoard();
    b[0] = 1;
    b[4] = 2;
    expect(legalMoves(b)).toEqual([1, 2, 3, 5, 6, 7, 8]);
  });

  it("isLegalMove rejects occupied, out-of-range, non-integers", () => {
    const b = emptyBoard();
    b[0] = 1;
    expect(isLegalMove(b, 0)).toBe(false);
    expect(isLegalMove(b, -1)).toBe(false);
    expect(isLegalMove(b, 9)).toBe(false);
    expect(isLegalMove(b, 1.5)).toBe(false);
    expect(isLegalMove(b, 1)).toBe(true);
  });

  it("applyMove places the marker and returns a new board", () => {
    const before = emptyBoard();
    const after = applyMove(before, 4, 1);
    expect(before[4]).toBe(0); // unchanged
    expect(after[4]).toBe(1);
  });

  it("applyMove throws on illegal index", () => {
    const b = emptyBoard();
    b[0] = 1;
    expect(() => applyMove(b, 0, 2)).toThrow();
    expect(() => applyMove(b, 99, 1)).toThrow();
  });

  it("rowColOf and indexOf round-trip", () => {
    for (let i = 0; i < CELLS; i++) {
      const [r, c] = rowColOf(i);
      expect(indexOf(r, c)).toBe(i);
    }
  });

  it("detects every win line for each player", () => {
    for (const line of LINES) {
      for (const player of [1, 2] as const) {
        const b = emptyBoard();
        for (const cell of line) b[cell] = player;
        const r = checkResult(b);
        expect(r.status).toBe("win");
        if (r.status === "win") {
          expect(r.winner).toBe(player);
          expect(r.line).toEqual(line);
        }
      }
    }
  });

  it("detects draw on full board with no winner", () => {
    // X | O | X
    // X | O | O
    // O | X | X   ← no three-in-a-row
    const b: Board = [1, 2, 1, 1, 2, 2, 2, 1, 1];
    expect(checkResult(b).status).toBe("draw");
  });

  it("returns ongoing for non-terminal positions", () => {
    const b = emptyBoard();
    expect(checkResult(b).status).toBe("ongoing");
    b[4] = 1;
    expect(checkResult(b).status).toBe("ongoing");
  });

  it("opponentOf flips 1↔2", () => {
    expect(opponentOf(1)).toBe(2);
    expect(opponentOf(2)).toBe(1);
  });

  it("renderBoard ascii-grids the state", () => {
    const b = emptyBoard();
    b[0] = 1;
    b[4] = 2;
    b[8] = 1;
    expect(renderBoard(b)).toBe("X . .\n. O .\n. . X");
  });
});

describe("tic-tac-toe boardgame.io definition", () => {
  it("setup returns an empty board state", () => {
    const initial = (game.setup as () => { board: Board; lastMove: unknown })();
    expect(initial.board).toEqual(emptyBoard());
    expect(initial.lastMove).toBeNull();
  });

  it("endIf detects winner mapped to playerID", () => {
    const won: Board = [1, 1, 1, 0, 0, 0, 0, 0, 0];
    const endIf = game.endIf as (ctx: { G: { board: Board } }) => unknown;
    expect(endIf({ G: { board: won } })).toEqual({ winner: "0" });

    const wonByP2: Board = [2, 2, 2, 0, 0, 0, 0, 0, 0];
    expect(endIf({ G: { board: wonByP2 } })).toEqual({ winner: "1" });
  });

  it("endIf detects draw", () => {
    const drawn: Board = [1, 2, 1, 1, 2, 2, 2, 1, 1];
    const endIf = game.endIf as (ctx: { G: { board: Board } }) => unknown;
    expect(endIf({ G: { board: drawn } })).toEqual({ draw: true });
  });
});
