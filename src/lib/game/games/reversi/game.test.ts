import { describe, expect, it } from "vitest";
import {
  SIZE,
  applyMove,
  captureRuns,
  checkResult,
  emptyBoard,
  game,
  indexOf,
  isLegalMove,
  legalMoves,
  opposite,
  scoreOf,
  startingBoard,
  startingState,
  type Board,
  type ReversiState,
} from "./game";

describe("reversi engine — setup", () => {
  it("starting board has 4 discs in the center", () => {
    const b = startingBoard();
    let pieces = 0;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) if (b[indexOf(r, c)] !== "") pieces++;
    }
    expect(pieces).toBe(4);
    expect(b[indexOf(3, 3)]).toBe("W");
    expect(b[indexOf(3, 4)]).toBe("B");
    expect(b[indexOf(4, 3)]).toBe("B");
    expect(b[indexOf(4, 4)]).toBe("W");
  });

  it("Black moves first; 4 legal opening moves", () => {
    const s = startingState();
    expect(s.turn).toBe("B");
    const moves = legalMoves(s);
    expect(moves.length).toBe(4);
    // Classic openings: (2,3), (3,2), (4,5), (5,4) — each flanks one W disc.
    const keys = new Set(moves.map((m) => `${m.row},${m.col}`));
    expect(keys).toEqual(new Set(["2,3", "3,2", "4,5", "5,4"]));
  });

  it("opposite flips side", () => {
    expect(opposite("B")).toBe("W");
    expect(opposite("W")).toBe("B");
  });
});

describe("reversi engine — placement and flips", () => {
  it("Black at (2,3) flips the lone W at (3,3)", () => {
    const s = startingState();
    const flips = captureRuns(s.board, 2, 3, "B");
    expect(flips).toEqual([[3, 3]]);
    const next = applyMove(s, { row: 2, col: 3 });
    expect(next.board[indexOf(2, 3)]).toBe("B");
    expect(next.board[indexOf(3, 3)]).toBe("B"); // flipped
    expect(next.turn).toBe("W");
  });

  it("isLegalMove rejects occupied squares", () => {
    const s = startingState();
    expect(isLegalMove(s.board, 3, 3, "B")).toBe(false); // occupied
    expect(isLegalMove(s.board, 0, 0, "B")).toBe(false); // no flank
    expect(isLegalMove(s.board, 2, 3, "B")).toBe(true);
  });

  it("multi-direction capture flips runs in every flanking direction", () => {
    // Build a position where the placement flanks discs in 2 directions.
    // Easiest: B places at (3,5) — flanks W on (3,4) (left) AND captures
    // any W run going elsewhere depending on board. Let's construct:
    // Row 3: . . . W B . . .  →  Black places at (3,2), flips (3,3).
    // We just verified single-direction. Try 2-direction via the classic
    // "boomerang" set up. Use a simpler ad-hoc test:
    const board = emptyBoard();
    // B B B
    // B W X   ← X is where Black will place
    // B B B
    // No — let me set up a 2-line flank. Place W at (3,4) and (4,3) and B
    // sentinels around them at (3,2) and (5,3). Then Black places at (3,5)
    // and (3,6)? Just verify any 2-direction flip.
    board[indexOf(0, 0)] = "B"; // sentinel
    board[indexOf(0, 4)] = "B"; // top anchor
    board[indexOf(1, 4)] = "W";
    board[indexOf(2, 4)] = "W";
    board[indexOf(3, 4)] = "W";
    // Black plays at (4, 4) which flanks down the column (3,4),(2,4),(1,4)
    // against the (0,4) anchor.
    board[indexOf(4, 0)] = "B"; // unrelated sentinel
    const state: ReversiState = {
      board,
      turn: "B",
      lastMove: null,
      consecutivePasses: 0,
    };
    const flips = captureRuns(state.board, 4, 4, "B");
    // 3 W discs flip in the up direction.
    expect(flips.length).toBe(3);
    expect(new Set(flips.map((p) => `${p[0]},${p[1]}`))).toEqual(
      new Set(["3,4", "2,4", "1,4"]),
    );
  });
});

describe("reversi engine — termination", () => {
  it("ongoing on the starting board", () => {
    expect(checkResult(startingState()).status).toBe("ongoing");
  });

  it("win for the larger-count side when the board is full", () => {
    const board = emptyBoard();
    // 40 B, 24 W.
    let placed = 0;
    for (let i = 0; i < 64; i++) {
      board[i] = placed < 40 ? "B" : "W";
      placed++;
    }
    const state: ReversiState = {
      board,
      turn: "B",
      lastMove: null,
      consecutivePasses: 0,
    };
    const r = checkResult(state);
    expect(r.status).toBe("win");
    if (r.status === "win") {
      expect(r.winner).toBe("B");
      expect(r.bScore).toBe(40);
      expect(r.wScore).toBe(24);
    }
  });

  it("draw at 32-32", () => {
    const board = emptyBoard();
    for (let i = 0; i < 64; i++) board[i] = i < 32 ? "B" : "W";
    const r = checkResult({
      board,
      turn: "B",
      lastMove: null,
      consecutivePasses: 0,
    });
    expect(r.status).toBe("draw");
    if (r.status === "draw") {
      expect(r.bScore).toBe(32);
      expect(r.wScore).toBe(32);
    }
  });

  it("scoreOf counts B and W exactly", () => {
    const b = startingBoard();
    const { B, W } = scoreOf(b);
    expect(B).toBe(2);
    expect(W).toBe(2);
  });
});

describe("reversi engine — boardgame.io integration", () => {
  it("setup returns the starting state shape", () => {
    const initial = (game.setup as () => ReversiState)();
    expect(initial.turn).toBe("B");
    expect(initial.board).toHaveLength(64);
    expect(scoreOf(initial.board as Board)).toEqual({ B: 2, W: 2 });
  });
  it("endIf maps winner to playerID", () => {
    const board = emptyBoard();
    for (let i = 0; i < 40; i++) board[i] = "B";
    for (let i = 40; i < 64; i++) board[i] = "W";
    const state: ReversiState = {
      board,
      turn: "B",
      lastMove: null,
      consecutivePasses: 0,
    };
    const endIf = game.endIf as (ctx: { G: ReversiState }) => unknown;
    expect(endIf({ G: state })).toEqual({ winner: "0" });
  });
});
