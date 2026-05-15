import { describe, expect, it } from "vitest";
import {
  SIZE,
  applyMove,
  checkResult,
  emptyBoard,
  game,
  indexOf,
  isDarkSquare,
  legalMoves,
  opposite,
  startingBoard,
  startingState,
  type CheckersMove,
  type CheckersState,
} from "./game";

function findMove(state: CheckersState, from: [number, number], path: Array<[number, number]>): CheckersMove | undefined {
  return legalMoves(state).find(
    (m) =>
      m.from[0] === from[0] &&
      m.from[1] === from[1] &&
      m.path.length === path.length &&
      m.path.every((p, i) => p[0] === path[i][0] && p[1] === path[i][1]),
  );
}

describe("checkers — setup", () => {
  it("starting board has 24 pieces on dark squares only", () => {
    const b = startingBoard();
    let pieces = 0;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const cell = b[indexOf(r, c)];
        if (cell !== "") {
          pieces++;
          expect(isDarkSquare(r, c)).toBe(true);
          // Pieces only in rows 0–2 (black) and 5–7 (white).
          expect([0, 1, 2, 5, 6, 7]).toContain(r);
          if (r <= 2) expect(cell).toBe("Bm");
          else expect(cell).toBe("Wm");
        }
      }
    }
    expect(pieces).toBe(24);
  });

  it("starting state — White to move, no captures yet, 7 slides available", () => {
    const s = startingState();
    expect(s.turn).toBe("W");
    expect(s.halfmoveClock).toBe(0);
    expect(s.lastMove).toBeNull();
    // White's front rank (row 5) has 4 men; each can slide diagonally
    // forward to the empty row 4. Some can only go one way (edges).
    expect(legalMoves(s).length).toBe(7);
  });

  it("opposite flips side", () => {
    expect(opposite("W")).toBe("B");
    expect(opposite("B")).toBe("W");
  });
});

describe("checkers — slides", () => {
  it("White man slides one square diagonally forward", () => {
    const s = startingState();
    const move = findMove(s, [5, 0], [[4, 1]]);
    expect(move).toBeDefined();
    const next = applyMove(s, move!);
    expect(next.board[indexOf(5, 0)]).toBe("");
    expect(next.board[indexOf(4, 1)]).toBe("Wm");
    expect(next.turn).toBe("B");
  });

  it("a White man can't slide backward", () => {
    const s = startingState();
    // (5, 2) → (6, 1) would be a backward slide; not legal.
    expect(findMove(s, [5, 2], [[6, 1]])).toBeUndefined();
  });
});

describe("checkers — captures", () => {
  it("a single jump removes the captured piece and lands beyond", () => {
    const board = emptyBoard();
    board[indexOf(5, 2)] = "Wm";
    board[indexOf(4, 3)] = "Bm";
    // White King and Black King added so neither side is empty (avoids
    // the no-pieces termination — captures need a non-terminal state).
    board[indexOf(7, 0)] = "Wk";
    board[indexOf(0, 7)] = "Bk";
    const state: CheckersState = {
      board,
      turn: "W",
      halfmoveClock: 0,
      lastMove: null,
    };
    const move = findMove(state, [5, 2], [[3, 4]]);
    expect(move).toBeDefined();
    const next = applyMove(state, move!);
    expect(next.board[indexOf(5, 2)]).toBe("");
    expect(next.board[indexOf(4, 3)]).toBe(""); // captured
    expect(next.board[indexOf(3, 4)]).toBe("Wm");
  });

  it("captures are mandatory — slides disappear when a capture exists", () => {
    const board = emptyBoard();
    board[indexOf(5, 2)] = "Wm";
    board[indexOf(4, 3)] = "Bm"; // jumpable
    board[indexOf(5, 4)] = "Wm"; // can slide
    board[indexOf(7, 0)] = "Wk";
    board[indexOf(0, 7)] = "Bk";
    const state: CheckersState = {
      board,
      turn: "W",
      halfmoveClock: 0,
      lastMove: null,
    };
    const moves = legalMoves(state);
    // Every legal move must be a jump (path step of distance 2).
    for (const m of moves) {
      const last = m.path[0];
      expect(Math.abs(last[0] - m.from[0])).toBe(2);
    }
  });

  it("multi-jump chain captures two pieces", () => {
    const board = emptyBoard();
    board[indexOf(7, 0)] = "Wk"; // sentinel so White has > 1 piece
    board[indexOf(0, 7)] = "Bk"; // sentinel for Black
    board[indexOf(5, 2)] = "Wm";
    board[indexOf(4, 3)] = "Bm";
    board[indexOf(2, 3)] = "Bm"; // second hop target
    const state: CheckersState = {
      board,
      turn: "W",
      halfmoveClock: 0,
      lastMove: null,
    };
    const move = findMove(state, [5, 2], [[3, 4], [1, 2]]);
    expect(move).toBeDefined();
    const next = applyMove(state, move!);
    expect(next.board[indexOf(4, 3)]).toBe(""); // first capture
    expect(next.board[indexOf(2, 3)]).toBe(""); // second capture
    // Lands on row 1, then continues by promotion to king? No — row 1 isn't
    // the back rank, so the piece stays a man.
    expect(next.board[indexOf(1, 2)]).toBe("Wm");
  });

  it("man promoted mid-chain becomes a king at the landing square", () => {
    // White man one step from the back rank captures, lands on row 0 — becomes king.
    const board = emptyBoard();
    board[indexOf(7, 0)] = "Wk"; // sentinel
    board[indexOf(0, 7)] = "Bk"; // sentinel
    board[indexOf(2, 5)] = "Wm";
    board[indexOf(1, 4)] = "Bm"; // jumpable: (2,5) → (0,3)
    const state: CheckersState = {
      board,
      turn: "W",
      halfmoveClock: 0,
      lastMove: null,
    };
    const move = findMove(state, [2, 5], [[0, 3]]);
    expect(move).toBeDefined();
    const next = applyMove(state, move!);
    expect(next.board[indexOf(0, 3)]).toBe("Wk");
  });
});

describe("checkers — promotion (end of slide)", () => {
  it("White man reaching row 0 becomes a king", () => {
    const board = emptyBoard();
    board[indexOf(1, 0)] = "Wm";
    board[indexOf(7, 7)] = "Wk"; // sentinel
    board[indexOf(0, 7)] = "Bk"; // sentinel
    const state: CheckersState = {
      board,
      turn: "W",
      halfmoveClock: 0,
      lastMove: null,
    };
    const move = findMove(state, [1, 0], [[0, 1]]);
    expect(move).toBeDefined();
    const next = applyMove(state, move!);
    expect(next.board[indexOf(0, 1)]).toBe("Wk");
  });

  it("Black man reaching row 7 becomes a king", () => {
    const board = emptyBoard();
    board[indexOf(6, 1)] = "Bm";
    board[indexOf(7, 7)] = "Wk"; // sentinel
    board[indexOf(0, 7)] = "Bk"; // sentinel
    const state: CheckersState = {
      board,
      turn: "B",
      halfmoveClock: 0,
      lastMove: null,
    };
    const move = findMove(state, [6, 1], [[7, 0]]);
    expect(move).toBeDefined();
    const next = applyMove(state, move!);
    expect(next.board[indexOf(7, 0)]).toBe("Bk");
  });
});

describe("checkers — termination", () => {
  it("opponent with no pieces → win for the other side", () => {
    const board = emptyBoard();
    board[indexOf(0, 1)] = "Wk";
    // Black is empty. Black to move means Black loses.
    const state: CheckersState = {
      board,
      turn: "B",
      halfmoveClock: 0,
      lastMove: null,
    };
    const r = checkResult(state);
    expect(r.status).toBe("win");
    if (r.status === "win") {
      expect(r.winner).toBe("W");
      expect(r.reason).toBe("no_pieces");
    }
  });

  it("opponent with no legal moves → win", () => {
    // Black piece on (0,0) blocked: only legal direction is (1,1), and (1,1)
    // is occupied by a White king with backup so jumping it doesn't land
    // safely (landing (2,2) is empty so actually that IS a jump → not
    // blocked). Use this trickier setup: Bm at (0,0), Wm at (1,1), Wm at
    // (2,2). The Bm can't slide (only forward is (1,1) occupied by own-
    // color? no, opposite) — it must jump (1,1) to land on (2,2), but
    // (2,2) is occupied. So Bm is stuck. White also needs a piece (else
    // no_pieces fires before no_moves).
    const board = emptyBoard();
    board[indexOf(0, 0)] = "Bm";
    board[indexOf(1, 1)] = "Wm";
    board[indexOf(2, 2)] = "Wm";
    const state: CheckersState = {
      board,
      turn: "B",
      halfmoveClock: 0,
      lastMove: null,
    };
    const r = checkResult(state);
    expect(r.status).toBe("win");
    if (r.status === "win") {
      expect(r.winner).toBe("W");
      expect(r.reason).toBe("no_moves");
    }
  });

  it("40-move rule fires as draw", () => {
    const board = emptyBoard();
    board[indexOf(0, 1)] = "Wk";
    board[indexOf(7, 6)] = "Bk";
    const state: CheckersState = {
      board,
      turn: "W",
      halfmoveClock: 40,
      lastMove: null,
    };
    const r = checkResult(state);
    expect(r.status).toBe("draw");
    if (r.status === "draw") expect(r.reason).toBe("fortymove");
  });
});

describe("checkers — boardgame.io integration", () => {
  it("setup returns the starting state shape", () => {
    const initial = (game.setup as () => CheckersState)();
    expect(initial.turn).toBe("W");
    expect(initial.board).toHaveLength(64);
  });

  it("endIf maps winner to playerID", () => {
    const board = emptyBoard();
    board[indexOf(0, 1)] = "Wk";
    const state: CheckersState = {
      board,
      turn: "B",
      halfmoveClock: 0,
      lastMove: null,
    };
    const endIf = game.endIf as (ctx: { G: CheckersState }) => unknown;
    expect(endIf({ G: state })).toEqual({ winner: "0" });
  });
});
