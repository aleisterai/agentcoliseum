import { describe, expect, it } from "vitest";
import {
  applyMove,
  checkResult,
  emptyBoard,
  hashState,
  legalMoves,
  squareIndex,
  startingState,
  type ChessState,
} from "./game";
import { easyBot, hardBot, mediumBot } from "./bots";

describe("chess bots — legal moves only", () => {
  it("easyBot picks a legal move on a fresh board", () => {
    const s = startingState();
    const m = easyBot.pickMove(s, "0");
    const legal = legalMoves(s);
    const match = legal.find(
      (x) => x.from === squareIndex(m.from) && x.to === squareIndex(m.to),
    );
    expect(match).toBeDefined();
  });

  it("mediumBot picks a legal move on a fresh board", () => {
    const s = startingState();
    const m = mediumBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.from === squareIndex(m.from) && x.to === squareIndex(m.to))).toBe(true);
  });

  // hardBot runs depth-5 negamax with piece-square tables. Solo
  // run = ~14s; under parallel pglite-heavy suite contention the
  // 15s cap was too tight. 30s gives comfortable headroom — the
  // bot itself is fast in isolation, this is purely CPU sharing.
  it("hardBot picks a legal move on a fresh board", { timeout: 30_000 }, () => {
    const s = startingState();
    const m = hardBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.from === squareIndex(m.from) && x.to === squareIndex(m.to))).toBe(true);
  });
});

describe("chess bots — tactical", () => {
  it("hardBot finds a one-move mate", () => {
    // Classic king + rook ladder mate.
    // Wg6 controls f7/g7/h7. White rook on a1 swings to a8 → Bh8 is in check
    // along rank 8 with every escape square attacked (g7/h7 by Wg6, g8 by the
    // rook itself). Mate in one.
    const board = emptyBoard();
    board[squareIndex("g6")] = "WK";
    board[squareIndex("a1")] = "WR";
    board[squareIndex("h8")] = "BK";
    const state: ChessState = {
      board,
      turn: "W",
      castling: { wK: false, wQ: false, bK: false, bQ: false },
      enPassantTarget: null,
      halfmoveClock: 0,
      fullmoveNumber: 1,
      positionHistory: [hashState(board, "W", { wK: false, wQ: false, bK: false, bQ: false }, null)],
      lastMove: null,
    };
    const chosen = hardBot.pickMove(state, "0");
    expect(chosen.from).toBe("a1");
    expect(chosen.to).toBe("a8");

    const moveObj = legalMoves(state).find(
      (m) => m.from === squareIndex("a1") && m.to === squareIndex("a8"),
    );
    expect(moveObj).toBeDefined();
    const next = applyMove(state, moveObj!);
    const result = checkResult(next);
    expect(result.status).toBe("win");
    if (result.status === "win") {
      expect(result.winner).toBe("W");
      expect(result.reason).toBe("checkmate");
    }
  });

  it("mediumBot captures a hanging queen", () => {
    // White N on c3, Black Q on b5 (undefended), Black K on e8, White K on e1.
    // Best move: Nxb5 capturing the queen.
    const board = emptyBoard();
    board[squareIndex("e1")] = "WK";
    board[squareIndex("e8")] = "BK";
    board[squareIndex("c3")] = "WN";
    board[squareIndex("b5")] = "BQ";
    const state: ChessState = {
      board,
      turn: "W",
      castling: { wK: false, wQ: false, bK: false, bQ: false },
      enPassantTarget: null,
      halfmoveClock: 0,
      fullmoveNumber: 1,
      positionHistory: [],
      lastMove: null,
    };
    const m = mediumBot.pickMove(state, "0");
    expect(m.from).toBe("c3");
    expect(m.to).toBe("b5");
  });
});
