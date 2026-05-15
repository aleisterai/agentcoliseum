import { describe, expect, it } from "vitest";
import {
  COLS,
  ROWS,
  applyMove,
  checkResult,
  cloneBoard,
  emptyBoard,
  isLegalMove,
  landingRow,
  legalMoves,
  opponentOf,
  renderBoard,
  game as connect4Game,
} from "./game";
import { buildEngine } from "@/lib/game/engine";

/**
 * Helper: build a board from a multiline string. Use ".", "X" (=1), "O" (=2).
 * 6 rows × 7 cols, top row first.
 */
function parse(diagram: string) {
  const rows = diagram
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/));
  if (rows.length !== ROWS || rows.some((r) => r.length !== COLS)) {
    throw new Error(`Test diagram must be ${ROWS}×${COLS}; got ${rows.length}×${rows[0]?.length ?? 0}`);
  }
  return rows.map((row) =>
    row.map((cell) => (cell === "." ? 0 : cell === "X" ? 1 : cell === "O" ? 2 : NaN)),
  );
}

describe("emptyBoard", () => {
  it("has the right shape and is all zeros", () => {
    const b = emptyBoard();
    expect(b.length).toBe(ROWS);
    expect(b[0].length).toBe(COLS);
    expect(b.flat().every((v) => v === 0)).toBe(true);
  });
});

describe("landingRow / isLegalMove / legalMoves", () => {
  it("a fresh board has the floor as the landing row in every column", () => {
    const b = emptyBoard();
    for (let c = 0; c < COLS; c++) expect(landingRow(b, c)).toBe(ROWS - 1);
  });

  it("rejects out-of-range columns", () => {
    const b = emptyBoard();
    expect(isLegalMove(b, -1)).toBe(false);
    expect(isLegalMove(b, COLS)).toBe(false);
  });

  it("marks a full column as illegal", () => {
    let b = emptyBoard();
    for (let i = 0; i < ROWS; i++) b = applyMove(b, 3, (i % 2 === 0 ? 1 : 2) as 1 | 2);
    expect(isLegalMove(b, 3)).toBe(false);
    expect(legalMoves(b)).toEqual([0, 1, 2, 4, 5, 6]);
  });
});

describe("applyMove", () => {
  it("stacks pieces from the bottom up", () => {
    let b = emptyBoard();
    b = applyMove(b, 0, 1);
    b = applyMove(b, 0, 2);
    b = applyMove(b, 0, 1);
    expect(b[ROWS - 1][0]).toBe(1);
    expect(b[ROWS - 2][0]).toBe(2);
    expect(b[ROWS - 3][0]).toBe(1);
  });

  it("does not mutate the input board", () => {
    const a = emptyBoard();
    const b = applyMove(a, 3, 1);
    expect(a[ROWS - 1][3]).toBe(0);
    expect(b[ROWS - 1][3]).toBe(1);
  });

  it("throws on an illegal move", () => {
    let b = emptyBoard();
    for (let i = 0; i < ROWS; i++) b = applyMove(b, 0, 1);
    expect(() => applyMove(b, 0, 2)).toThrow(/illegal/);
    expect(() => applyMove(b, -1, 1)).toThrow(/illegal/);
    expect(() => applyMove(b, COLS, 1)).toThrow(/illegal/);
  });
});

describe("checkResult — wins", () => {
  it("detects a horizontal win for player 1", () => {
    const b = parse(`
      . . . . . . .
      . . . . . . .
      . . . . . . .
      . . . . . . .
      . . . . . . .
      X X X X . . .
    `);
    const r = checkResult(b);
    expect(r.status).toBe("win");
    if (r.status === "win") {
      expect(r.winner).toBe(1);
      expect(r.line.length).toBe(4);
    }
  });

  it("detects a vertical win for player 2", () => {
    const b = parse(`
      . . . . . . .
      . . . . . . .
      . . O . . . .
      . . O . . . .
      . . O . . . .
      . . O . . . .
    `);
    const r = checkResult(b);
    expect(r.status).toBe("win");
    if (r.status === "win") expect(r.winner).toBe(2);
  });

  it("detects a down-right diagonal win (↘)", () => {
    const b = parse(`
      . . . . . . .
      . . . . . . .
      X . . . . . .
      . X . . . . .
      . . X . . . .
      . . . X . . .
    `);
    const r = checkResult(b);
    expect(r.status).toBe("win");
    if (r.status === "win") expect(r.winner).toBe(1);
  });

  it("detects an up-right diagonal win (↗)", () => {
    const b = parse(`
      . . . . . . .
      . . . . . . .
      . . . O . . .
      . . O . . . .
      . O . . . . .
      O . . . . . .
    `);
    const r = checkResult(b);
    expect(r.status).toBe("win");
    if (r.status === "win") expect(r.winner).toBe(2);
  });
});

describe("checkResult — draws and ongoing", () => {
  it("returns ongoing on a fresh board", () => {
    expect(checkResult(emptyBoard()).status).toBe("ongoing");
  });

  it("returns ongoing when no one has 4 in a row yet", () => {
    const b = parse(`
      . . . . . . .
      . . . . . . .
      . . . . . . .
      . . . . . . .
      . . X O . . .
      . . X O X . .
    `);
    expect(checkResult(b).status).toBe("ongoing");
  });

  it("returns draw on a full board with no win", () => {
    const b = parse(`
      X X O O X X O
      O O X X O O X
      X X O O X X O
      O O X X O O X
      X X O O X X O
      O O X X O O X
    `);
    expect(checkResult(b).status).toBe("draw");
  });
});

describe("opponentOf / cloneBoard / renderBoard", () => {
  it("opponentOf flips the player", () => {
    expect(opponentOf(1)).toBe(2);
    expect(opponentOf(2)).toBe(1);
  });

  it("cloneBoard is a deep copy", () => {
    const a = emptyBoard();
    const b = cloneBoard(a);
    b[0][0] = 1;
    expect(a[0][0]).toBe(0);
  });

  it("renderBoard produces 6 lines of 7 chars each", () => {
    const out = renderBoard(emptyBoard()).split("\n");
    expect(out.length).toBe(ROWS);
    for (const line of out) expect(line.replace(/\s/g, "").length).toBe(COLS);
  });
});

describe("boardgame.io engine round-trip", () => {
  it("initial state has an empty 6×7 board and no last move", () => {
    const engine = buildEngine(connect4Game);
    const s = engine.initialState();
    expect(s.G.board).toEqual(emptyBoard());
    expect(s.G.lastMove).toBeNull();
    expect(engine.gameOver(s)).toBeNull();
  });

  it("applies a legal move and rejects an out-of-range one", () => {
    const engine = buildEngine(connect4Game);
    const s0 = engine.initialState();
    const s1 = engine.applyMove(s0, "0", "drop", [3]);
    expect(s1).not.toBeNull();
    expect(s1!.G.board[ROWS - 1][3]).toBe(1);
    expect(s1!.G.lastMove).toEqual({ row: ROWS - 1, col: 3, player: 1 });
    const sBad = engine.applyMove(s1!, "1", "drop", [99]);
    expect(sBad).toBeNull();
  });

  it("rejects a drop into a full column", () => {
    const engine = buildEngine(connect4Game);
    let s = engine.initialState();
    // Fill column 0 by alternating players.
    for (let i = 0; i < ROWS; i++) {
      const pid: "0" | "1" = i % 2 === 0 ? "0" : "1";
      const next = engine.applyMove(s, pid, "drop", [0]);
      expect(next).not.toBeNull();
      s = next!;
    }
    const blocked = engine.applyMove(s, "0", "drop", [0]);
    expect(blocked).toBeNull();
  });

  it("declares the winner via endIf and stops accepting moves", () => {
    const engine = buildEngine(connect4Game);
    let s = engine.initialState();
    // Player 0 (X = 1) wins along the bottom row in columns 0..3 by alternating
    // with player 1 dropping into columns 4..6 then 4 again.
    const sequence: Array<["0" | "1", number]> = [
      ["0", 0], ["1", 4],
      ["0", 1], ["1", 5],
      ["0", 2], ["1", 6],
      ["0", 3], // win
    ];
    for (const [pid, col] of sequence) {
      const next = engine.applyMove(s, pid, "drop", [col]);
      expect(next).not.toBeNull();
      s = next!;
    }
    const over = engine.gameOver(s);
    expect(over).not.toBeNull();
    expect(over!.winnerPlayerID).toBe("0");
    expect(over!.isDraw).toBe(false);
  });
});
