import { describe, expect, it } from "vitest";
import {
  applyMove,
  checkResult,
  emptyBoard,
  findKing,
  hashState,
  indexOf,
  isInCheck,
  isSquareAttacked,
  legalMoves,
  opposite,
  renderBoard,
  rowColOf,
  squareIndex,
  squareName,
  startingBoard,
  startingState,
  type ChessState,
  type Piece,
} from "./game";

function findMove(state: ChessState, from: string, to: string) {
  const fromIdx = squareIndex(from);
  const toIdx = squareIndex(to);
  return legalMoves(state).find((m) => m.from === fromIdx && m.to === toIdx);
}

function playSequence(seq: Array<[string, string] | [string, string, "Q" | "R" | "B" | "N"]>): ChessState {
  let s = startingState();
  for (const step of seq) {
    const [from, to, promo] = step;
    const fromIdx = squareIndex(from);
    const toIdx = squareIndex(to);
    const m = legalMoves(s).find(
      (mv) => mv.from === fromIdx && mv.to === toIdx && (mv.promotion ?? null) === (promo ?? null),
    );
    if (!m) throw new Error(`illegal in sequence: ${from}-${to}${promo ? `=${promo}` : ""}`);
    s = applyMove(s, m);
  }
  return s;
}

describe("chess engine — coordinates", () => {
  it("squareIndex / squareName round-trip", () => {
    for (let i = 0; i < 64; i++) expect(squareIndex(squareName(i))).toBe(i);
  });
  it("a8 == 0, h1 == 63, e4 == 36", () => {
    expect(squareIndex("a8")).toBe(0);
    expect(squareIndex("h1")).toBe(63);
    expect(squareIndex("e4")).toBe(36);
    expect(squareIndex("e2")).toBe(52);
  });
  it("rejects malformed names", () => {
    expect(() => squareIndex("z9")).toThrow();
    expect(() => squareIndex("a0")).toThrow();
    expect(() => squareIndex("")).toThrow();
  });
  it("rowColOf / indexOf round-trip", () => {
    for (let i = 0; i < 64; i++) {
      const [r, c] = rowColOf(i);
      expect(indexOf(r, c)).toBe(i);
    }
  });
});

describe("chess engine — starting position", () => {
  it("starts with 32 pieces in correct ranks", () => {
    const b = startingBoard();
    // back ranks
    expect(b[0]).toBe("BR");
    expect(b[4]).toBe("BK");
    expect(b[7]).toBe("BR");
    expect(b[60]).toBe("WK");
    expect(b[63]).toBe("WR");
    // pawn ranks
    for (let c = 0; c < 8; c++) {
      expect(b[8 + c]).toBe("BP");
      expect(b[48 + c]).toBe("WP");
    }
    // middle empty
    for (let i = 16; i < 48; i++) expect(b[i]).toBe("");
  });

  it("startingState — white to move, castling rights both colors, ep null", () => {
    const s = startingState();
    expect(s.turn).toBe("W");
    expect(s.castling).toEqual({ wK: true, wQ: true, bK: true, bQ: true });
    expect(s.enPassantTarget).toBeNull();
    expect(s.halfmoveClock).toBe(0);
    expect(s.fullmoveNumber).toBe(1);
  });

  it("starting legal moves: 20 for white", () => {
    const s = startingState();
    expect(legalMoves(s).length).toBe(20);
  });
});

describe("chess engine — pawns", () => {
  it("two-square push from starting rank, sets ep target", () => {
    const s = playSequence([["e2", "e4"]]);
    expect(s.board[squareIndex("e4")]).toBe("WP");
    expect(s.board[squareIndex("e2")]).toBe("");
    expect(s.enPassantTarget).toBe(squareIndex("e3"));
  });

  it("en passant capture", () => {
    // 1. e4 d5 2. e5 f5 3. exf6 e.p.
    const s = playSequence([
      ["e2", "e4"],
      ["d7", "d5"],
      ["e4", "e5"],
      ["f7", "f5"],
      ["e5", "f6"],
    ]);
    expect(s.board[squareIndex("f6")]).toBe("WP");
    expect(s.board[squareIndex("f5")]).toBe(""); // captured pawn gone
  });

  it("ep target clears the next move", () => {
    const s = playSequence([["e2", "e4"], ["a7", "a6"]]);
    expect(s.enPassantTarget).toBeNull();
  });

  it("promotion creates a queen by default; choices supported", () => {
    // White pawn one rank from promotion, then push to back rank.
    const seed = emptyBoard();
    seed[squareIndex("a7")] = "WP";
    seed[squareIndex("e1")] = "WK";
    seed[squareIndex("e8")] = "BK";
    const state: ChessState = {
      board: seed,
      turn: "W",
      castling: { wK: false, wQ: false, bK: false, bQ: false },
      enPassantTarget: null,
      halfmoveClock: 0,
      fullmoveNumber: 1,
      positionHistory: [hashState(seed, "W", { wK: false, wQ: false, bK: false, bQ: false }, null)],
      lastMove: null,
    };
    // legalMoves enumerates 4 promotions
    const promos = legalMoves(state).filter((m) => m.from === squareIndex("a7") && m.to === squareIndex("a8"));
    expect(promos.length).toBe(4);
    const ranks = new Set(promos.map((m) => m.promotion));
    expect(ranks).toEqual(new Set(["Q", "R", "B", "N"]));

    const next = applyMove(state, promos.find((m) => m.promotion === "N")!);
    expect(next.board[squareIndex("a8")]).toBe("WN");
  });
});

describe("chess engine — castling", () => {
  it("white castles king-side (O-O)", () => {
    // Clear the king-side pieces between e1 and h1.
    const board = startingBoard();
    board[squareIndex("f1")] = "";
    board[squareIndex("g1")] = "";
    const state: ChessState = {
      board,
      turn: "W",
      castling: { wK: true, wQ: true, bK: true, bQ: true },
      enPassantTarget: null,
      halfmoveClock: 0,
      fullmoveNumber: 1,
      positionHistory: [hashState(board, "W", { wK: true, wQ: true, bK: true, bQ: true }, null)],
      lastMove: null,
    };
    const castle = legalMoves(state).find((m) => m.from === squareIndex("e1") && m.to === squareIndex("g1"));
    expect(castle).toBeDefined();
    const next = applyMove(state, castle!);
    expect(next.board[squareIndex("g1")]).toBe("WK");
    expect(next.board[squareIndex("f1")]).toBe("WR");
    expect(next.castling).toEqual({ wK: false, wQ: false, bK: true, bQ: true });
  });

  it("castling forbidden when king passes through attacked square", () => {
    // Black rook on f4 down an open f-file attacks f1; White can't castle short.
    const board = startingBoard();
    board[squareIndex("f1")] = "";
    board[squareIndex("g1")] = "";
    board[squareIndex("f2")] = ""; // clear the f-pawn so the rook actually sees f1
    board[squareIndex("f4")] = "BR";
    const state: ChessState = {
      board,
      turn: "W",
      castling: { wK: true, wQ: true, bK: true, bQ: true },
      enPassantTarget: null,
      halfmoveClock: 0,
      fullmoveNumber: 1,
      positionHistory: [],
      lastMove: null,
    };
    const castle = legalMoves(state).find((m) => m.from === squareIndex("e1") && m.to === squareIndex("g1"));
    expect(castle).toBeUndefined();
  });

  it("castling rights drop when king moves", () => {
    const s = playSequence([["e2", "e3"], ["e7", "e6"], ["e1", "e2"]]);
    expect(s.castling.wK).toBe(false);
    expect(s.castling.wQ).toBe(false);
  });

  it("castling rights drop when rook moves", () => {
    const s = playSequence([["a2", "a3"], ["a7", "a6"], ["a1", "a2"]]);
    expect(s.castling.wQ).toBe(false);
    expect(s.castling.wK).toBe(true); // king-side untouched
  });
});

describe("chess engine — check / mate / stalemate", () => {
  it("Fool's Mate: White falls to Qh4#", () => {
    const s = playSequence([
      ["f2", "f3"],
      ["e7", "e5"],
      ["g2", "g4"],
      ["d8", "h4"], // ... Qh4#
    ]);
    const result = checkResult(s);
    expect(result.status).toBe("win");
    if (result.status === "win") {
      expect(result.winner).toBe("B");
      expect(result.reason).toBe("checkmate");
    }
  });

  it("Scholar's Mate: 4.Qxf7#", () => {
    const s = playSequence([
      ["e2", "e4"],
      ["e7", "e5"],
      ["f1", "c4"],
      ["b8", "c6"],
      ["d1", "h5"],
      ["g8", "f6"],
      ["h5", "f7"], // Qxf7#
    ]);
    const result = checkResult(s);
    expect(result.status).toBe("win");
    if (result.status === "win") expect(result.winner).toBe("W");
  });

  it("isInCheck returns true when king is attacked", () => {
    // Place black king on e8, white rook on e1 attacking down the e-file.
    const board = emptyBoard();
    board[squareIndex("e8")] = "BK";
    board[squareIndex("e1")] = "WR";
    board[squareIndex("a1")] = "WK";
    const state: ChessState = {
      board,
      turn: "B",
      castling: { wK: false, wQ: false, bK: false, bQ: false },
      enPassantTarget: null,
      halfmoveClock: 0,
      fullmoveNumber: 1,
      positionHistory: [],
      lastMove: null,
    };
    expect(isInCheck(state, "B")).toBe(true);
    expect(isInCheck(state, "W")).toBe(false);
  });

  it("Stalemate detected as draw", () => {
    // Classic stalemate: K on h8 (black), K on f7 and Q on g6 (white).
    // Black to move, no legal moves but not in check.
    const board = emptyBoard();
    board[squareIndex("h8")] = "BK";
    board[squareIndex("f7")] = "WK";
    board[squareIndex("g6")] = "WQ";
    const state: ChessState = {
      board,
      turn: "B",
      castling: { wK: false, wQ: false, bK: false, bQ: false },
      enPassantTarget: null,
      halfmoveClock: 0,
      fullmoveNumber: 1,
      positionHistory: [],
      lastMove: null,
    };
    const result = checkResult(state);
    expect(result.status).toBe("draw");
    if (result.status === "draw") expect(result.reason).toBe("stalemate");
  });
});

describe("chess engine — special draws", () => {
  it("50-move rule fires after 100 halfmoves with no pawn move / capture", () => {
    const board = emptyBoard();
    board[squareIndex("e1")] = "WK";
    board[squareIndex("e8")] = "BK";
    const state: ChessState = {
      board,
      turn: "W",
      castling: { wK: false, wQ: false, bK: false, bQ: false },
      enPassantTarget: null,
      halfmoveClock: 100,
      fullmoveNumber: 50,
      positionHistory: [],
      lastMove: null,
    };
    const result = checkResult(state);
    expect(result.status).toBe("draw");
    if (result.status === "draw") expect(result.reason).toBe("fifty_move");
  });

  it("Insufficient material: K vs K is a draw", () => {
    const board = emptyBoard();
    board[squareIndex("e1")] = "WK";
    board[squareIndex("e8")] = "BK";
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
    const result = checkResult(state);
    expect(result.status).toBe("draw");
    if (result.status === "draw") expect(result.reason).toBe("insufficient_material");
  });

  it("Threefold repetition triggers draw", () => {
    // Shuffle knights back and forth.
    const s = playSequence([
      ["g1", "f3"], ["g8", "f6"],
      ["f3", "g1"], ["f6", "g8"],
      ["g1", "f3"], ["g8", "f6"],
      ["f3", "g1"], ["f6", "g8"],
    ]);
    const result = checkResult(s);
    expect(result.status).toBe("draw");
    if (result.status === "draw") expect(result.reason).toBe("threefold");
  });
});

describe("chess engine — attack detection", () => {
  it("rook attacks along its file but stops at blockers", () => {
    const board = emptyBoard();
    board[squareIndex("a1")] = "WR";
    board[squareIndex("a4")] = "BP";
    expect(isSquareAttacked(board, squareIndex("a3"), "W")).toBe(true);
    expect(isSquareAttacked(board, squareIndex("a4"), "W")).toBe(true); // can capture
    expect(isSquareAttacked(board, squareIndex("a5"), "W")).toBe(false); // blocked
  });
  it("findKing locates each king", () => {
    const b = startingBoard();
    expect(findKing(b, "W")).toBe(squareIndex("e1"));
    expect(findKing(b, "B")).toBe(squareIndex("e8"));
  });
  it("opposite flips side", () => {
    expect(opposite("W")).toBe("B");
    expect(opposite("B")).toBe("W");
  });
});

describe("chess engine — renderBoard sanity", () => {
  it("starting position renders 8 lines of 8 chars each", () => {
    const out = renderBoard(startingBoard());
    const lines = out.split("\n");
    expect(lines.length).toBe(8);
    for (const l of lines) expect(l.split(" ").length).toBe(8);
  });
});

// Type-level sanity: ensure piece codes are exhaustive.
const _piecesExhaustive: Piece[] = [
  "WP", "WN", "WB", "WR", "WQ", "WK",
  "BP", "BN", "BB", "BR", "BQ", "BK",
];
void _piecesExhaustive;
void findMove;
