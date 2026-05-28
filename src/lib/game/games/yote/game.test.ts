import { describe, expect, it } from "vitest";
import { buildEngine } from "@/lib/game/engine";
import {
  N,
  PIECES_PER_PLAYER,
  applyMove,
  checkResult,
  game,
  isLegalMove,
  jumpedCell,
  legalMoves,
  opposite,
  startingState,
  totalPieces,
  type Cell,
  type YoteState,
} from "./game";
import { hardBot } from "./bots";

/** Build a state from a sparse cell map for targeted tests. */
function withBoard(
  cells: Record<number, Cell>,
  turn: "0" | "1" = "0",
  reserve = { "0": 0, "1": 0 },
): YoteState {
  const board = Array<Cell>(N).fill("");
  for (const [k, v] of Object.entries(cells)) board[Number(k)] = v;
  return { board, reserve: { ...reserve }, turn, lastMove: null, moveCount: 0 };
}

describe("yote — setup", () => {
  it("starts empty, 12 in reserve each, P0 to move", () => {
    const s = startingState();
    expect(s.board.every((c) => c === "")).toBe(true);
    expect(s.reserve).toEqual({ "0": PIECES_PER_PLAYER, "1": PIECES_PER_PLAYER });
    expect(s.turn).toBe("0");
  });
  it("opposite flips", () => {
    expect(opposite("0")).toBe("1");
    expect(opposite("1")).toBe("0");
  });
});

describe("yote — drops + moves", () => {
  it("drop places a piece and decrements reserve", () => {
    const s = startingState();
    const next = applyMove(s, { kind: "drop", to: 14 });
    expect(next.board[14]).toBe("0");
    expect(next.reserve["0"]).toBe(PIECES_PER_PLAYER - 1);
    expect(next.turn).toBe("1");
  });
  it("rejects dropping on an occupied cell", () => {
    const s = withBoard({ 14: "1" }, "0", { "0": 5, "1": 5 });
    expect(isLegalMove(s, { kind: "drop", to: 14 })).toBe(false);
  });
  it("rejects dropping with empty reserve", () => {
    const s = withBoard({ 0: "0" }, "0", { "0": 0, "1": 0 });
    expect(isLegalMove(s, { kind: "drop", to: 5 })).toBe(false);
  });
  it("move slides to an adjacent empty cell only", () => {
    const s = withBoard({ 14: "0" }, "0");
    expect(isLegalMove(s, { kind: "move", from: 14, to: 8 })).toBe(true); // up
    expect(isLegalMove(s, { kind: "move", from: 14, to: 15 })).toBe(true); // right
    expect(isLegalMove(s, { kind: "move", from: 14, to: 2 })).toBe(false); // 2 away
    expect(isLegalMove(s, { kind: "move", from: 14, to: 7 })).toBe(false); // diagonal
  });
});

describe("yote — capture + wild remove", () => {
  it("jumpedCell computes the middle of a 2-step orthogonal jump", () => {
    expect(jumpedCell(14, 2)).toBe(8); // up two
    expect(jumpedCell(14, 16)).toBe(15); // right two
    expect(jumpedCell(14, 7)).toBeNull(); // diagonal
  });
  it("capture removes the jumped piece AND the wild-remove target", () => {
    // P0 at 14 jumps the P1 at 8 into empty 2; wild-removes P1 at 20.
    const s = withBoard({ 14: "0", 8: "1", 20: "1" }, "0");
    expect(isLegalMove(s, { kind: "capture", from: 14, to: 2, remove: 20 })).toBe(true);
    const next = applyMove(s, { kind: "capture", from: 14, to: 2, remove: 20 });
    expect(next.board[2]).toBe("0");
    expect(next.board[14]).toBe("");
    expect(next.board[8]).toBe(""); // jumped
    expect(next.board[20]).toBe(""); // wild removed
    expect(next.turn).toBe("1");
  });
  it("requires a wild-remove target when other enemies exist; forbids null", () => {
    const s = withBoard({ 14: "0", 8: "1", 20: "1" }, "0");
    expect(isLegalMove(s, { kind: "capture", from: 14, to: 2, remove: null })).toBe(false);
  });
  it("allows null wild-remove when the jumped piece is the only enemy", () => {
    const s = withBoard({ 14: "0", 8: "1" }, "0");
    expect(isLegalMove(s, { kind: "capture", from: 14, to: 2, remove: null })).toBe(true);
  });
  it("rejects a capture over an empty or friendly middle cell", () => {
    const s = withBoard({ 14: "0", 8: "0" }, "0"); // friendly in the middle
    expect(isLegalMove(s, { kind: "capture", from: 14, to: 2, remove: null })).toBe(false);
  });
});

describe("yote — termination", () => {
  it("eliminating all opponent pieces wins", () => {
    // P0 jumps P1's only piece (8) landing on 2 — P1 reaches 0 total.
    const s = withBoard({ 14: "0", 8: "1" }, "0");
    const next = applyMove(s, { kind: "capture", from: 14, to: 2, remove: null });
    expect(totalPieces(next, "1")).toBe(0);
    const r = checkResult(next);
    expect(r.status).toBe("win");
    if (r.status === "win") expect(r.winner).toBe("0");
  });
  it("a player with no legal move loses", () => {
    // P1 to move, no pieces on board, no reserve → stalemate loss.
    const s = withBoard({ 0: "0" }, "1", { "0": 0, "1": 0 });
    const r = checkResult(s);
    expect(r.status).toBe("win");
    if (r.status === "win") expect(r.winner).toBe("0");
  });
  it("ongoing at the start", () => {
    expect(checkResult(startingState()).status).toBe("ongoing");
  });
});

describe("yote — legalMoves enumeration", () => {
  it("fresh board: only drops, one per empty cell", () => {
    const moves = legalMoves(startingState());
    expect(moves.length).toBe(N); // 30 empty cells, reserve available
    expect(moves.every((m) => m.kind === "drop")).toBe(true);
  });
  it("every enumerated move is legal", () => {
    const s = withBoard({ 14: "0", 8: "1", 20: "1", 9: "0" }, "0", { "0": 2, "1": 2 });
    const moves = legalMoves(s);
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) expect(isLegalMove(s, m)).toBe(true);
  });
});

describe("yote — boardgame.io", () => {
  it("setup matches startingState", () => {
    const initial = (game.setup as () => YoteState)();
    expect(initial.reserve["0"]).toBe(PIECES_PER_PLAYER);
  });
});

describe("yote — engine self-play (e2e)", () => {
  it("plays a full game to a terminal state through the real reducer", () => {
    // Drive both sides with hardBot through buildEngine — exercises the
    // boardgame.io `play` move handler, turn alternation, and endIf, not
    // just the pure functions. The MAX_MOVES cap guarantees termination.
    const engine = buildEngine(game);
    let state = engine.initialState();
    let over = engine.gameOver(state);
    let plies = 0;
    while (!over && plies < 260) {
      const G = state.G as YoteState;
      const move = hardBot.pickMove(G, G.turn);
      const next = engine.applyMove(state, G.turn, "play", [move]);
      expect(next, `engine rejected a legal move at ply ${plies}`).not.toBeNull();
      state = next!;
      over = engine.gameOver(state);
      plies += 1;
    }
    // Reached a real terminal state (win or draw) — never stuck.
    expect(over).not.toBeNull();
  });
});
