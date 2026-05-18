import { describe, expect, it } from "vitest";
import {
  BOX_COLS,
  BOX_ROWS,
  HE_COLS,
  HE_ROWS,
  TOTAL_BOXES,
  VE_COLS,
  VE_ROWS,
  applyMove,
  boxIndex,
  checkResult,
  game,
  hIndex,
  isLegalMove,
  legalMoves,
  opposite,
  sidesOfBox,
  startingState,
  vIndex,
  type DotsBoxesState,
} from "./game";

describe("dots-and-boxes — setup", () => {
  it("starting state: all edges empty, 0-0 score, player 0 to move", () => {
    const s = startingState();
    expect(s.hEdges.length).toBe(HE_ROWS * HE_COLS);
    expect(s.vEdges.length).toBe(VE_ROWS * VE_COLS);
    expect(s.boxes.length).toBe(TOTAL_BOXES);
    expect(s.boxes.every((b) => b === "")).toBe(true);
    expect(s.scores).toEqual({ "0": 0, "1": 0 });
    expect(s.turn).toBe("0");
  });

  it("starting position has 40 legal edges", () => {
    // 4×5 horizontal + 5×4 vertical = 20 + 20 = 40
    expect(legalMoves(startingState()).length).toBe(40);
  });

  it("opposite flips player", () => {
    expect(opposite("0")).toBe("1");
    expect(opposite("1")).toBe("0");
  });
});

describe("dots-and-boxes — placement legality", () => {
  it("isLegalMove rejects out-of-range and duplicate edges", () => {
    let s = startingState();
    expect(isLegalMove(s, { type: "h", row: 0, col: 0 })).toBe(true);
    s = applyMove(s, { type: "h", row: 0, col: 0 });
    expect(isLegalMove(s, { type: "h", row: 0, col: 0 })).toBe(false);
    expect(isLegalMove(s, { type: "h", row: -1, col: 0 })).toBe(false);
    expect(isLegalMove(s, { type: "v", row: 0, col: 99 })).toBe(false);
  });

  it("normal edge passes the turn", () => {
    const s = applyMove(startingState(), { type: "h", row: 0, col: 0 });
    expect(s.turn).toBe("1");
  });

  it("applyMove throws on illegal edge", () => {
    const s = applyMove(startingState(), { type: "h", row: 0, col: 0 });
    expect(() => applyMove(s, { type: "h", row: 0, col: 0 })).toThrow();
  });
});

describe("dots-and-boxes — box completion + turn rule", () => {
  it("closing the 4th side scores a box AND keeps the turn", () => {
    // Build box (0,0)'s four edges:
    //   top    = h(0,0); bottom = h(1,0); left = v(0,0); right = v(0,1)
    // Player 0 draws first 3 (passing turn each time), then player 1
    // draws the 4th — but player 1 should claim and keep turn.
    let s = startingState();
    s = applyMove(s, { type: "h", row: 0, col: 0 });   // P0; turn → P1
    s = applyMove(s, { type: "h", row: 1, col: 0 });   // P1; turn → P0
    s = applyMove(s, { type: "v", row: 0, col: 0 });   // P0; turn → P1
    expect(sidesOfBox(s, 0, 0)).toBe(3);
    s = applyMove(s, { type: "v", row: 0, col: 1 });   // P1 closes box (0,0)
    expect(s.boxes[boxIndex(0, 0)]).toBe("1");
    expect(s.scores["1"]).toBe(1);
    expect(s.turn).toBe("1"); // keeps turn
  });

  it("closing two boxes at once gives two points", () => {
    // Build adjacent boxes (0,0) and (0,1) so that drawing one shared
    // edge completes both.
    // Box (0,0): h(0,0), h(1,0), v(0,0), v(0,1) — share v(0,1).
    // Box (0,1): h(0,1), h(1,1), v(0,1), v(0,2) — share v(0,1).
    // Draw all 7 unique non-shared edges, then v(0,1) completes both.
    let s = startingState();
    const seq: Array<[string, number, number]> = [
      ["h", 0, 0],
      ["h", 1, 0],
      ["v", 0, 0],
      ["h", 0, 1],
      ["h", 1, 1],
      ["v", 0, 2],
      ["v", 1, 2], // extra harmless edge to flip turn back to P0
    ];
    for (const [t, r, c] of seq) {
      s = applyMove(s, { type: t as "h" | "v", row: r, col: c });
    }
    const beforeScore = { ...s.scores };
    const turnBefore = s.turn;
    s = applyMove(s, { type: "v", row: 0, col: 1 });
    // Two new boxes claimed.
    expect(s.scores[turnBefore]).toBe(beforeScore[turnBefore] + 2);
    expect(s.boxes[boxIndex(0, 0)]).toBe(turnBefore);
    expect(s.boxes[boxIndex(0, 1)]).toBe(turnBefore);
    // Same player keeps moving.
    expect(s.turn).toBe(turnBefore);
  });

  it("sidesOfBox counts 0..4 correctly", () => {
    let s = startingState();
    expect(sidesOfBox(s, 0, 0)).toBe(0);
    s = applyMove(s, { type: "h", row: 0, col: 0 });
    expect(sidesOfBox(s, 0, 0)).toBe(1);
    s = applyMove(s, { type: "v", row: 0, col: 0 });
    expect(sidesOfBox(s, 0, 0)).toBe(2);
  });
});

describe("dots-and-boxes — termination", () => {
  it("a full board ends the game with a winner", () => {
    // Synthesize an end-state: every edge drawn, score 9-7 for player 0.
    const s: DotsBoxesState = {
      hEdges: new Array(HE_ROWS * HE_COLS).fill(true),
      vEdges: new Array(VE_ROWS * VE_COLS).fill(true),
      boxes: new Array(BOX_ROWS * BOX_COLS).fill("") as ("" | "0" | "1")[],
      turn: "0",
      scores: { "0": 9, "1": 7 },
      lastMove: null,
    };
    // Fill boxes 0..8 to "0", 9..15 to "1" so the totals match scores.
    for (let i = 0; i < 9; i++) s.boxes[i] = "0";
    for (let i = 9; i < 16; i++) s.boxes[i] = "1";
    const r = checkResult(s);
    expect(r.status).toBe("win");
    if (r.status === "win") {
      expect(r.winner).toBe("0");
      expect(r.scores).toEqual({ "0": 9, "1": 7 });
    }
  });

  it("8-8 split is a draw", () => {
    const s: DotsBoxesState = {
      hEdges: new Array(HE_ROWS * HE_COLS).fill(true),
      vEdges: new Array(VE_ROWS * VE_COLS).fill(true),
      boxes: new Array(BOX_ROWS * BOX_COLS).fill("") as ("" | "0" | "1")[],
      turn: "0",
      scores: { "0": 8, "1": 8 },
      lastMove: null,
    };
    for (let i = 0; i < 8; i++) s.boxes[i] = "0";
    for (let i = 8; i < 16; i++) s.boxes[i] = "1";
    expect(checkResult(s).status).toBe("draw");
  });
});

describe("dots-and-boxes — coordinate helpers", () => {
  it("hIndex and vIndex are row-major", () => {
    expect(hIndex(0, 0)).toBe(0);
    expect(hIndex(0, HE_COLS - 1)).toBe(HE_COLS - 1);
    expect(hIndex(1, 0)).toBe(HE_COLS);
    expect(vIndex(0, 0)).toBe(0);
    expect(vIndex(1, 0)).toBe(VE_COLS);
  });
  it("boxIndex is row-major", () => {
    expect(boxIndex(0, 0)).toBe(0);
    expect(boxIndex(BOX_ROWS - 1, BOX_COLS - 1)).toBe(BOX_ROWS * BOX_COLS - 1);
  });
});

describe("dots-and-boxes — boardgame.io", () => {
  it("setup returns the starting state", () => {
    const initial = (game.setup as () => DotsBoxesState)();
    expect(initial.turn).toBe("0");
    expect(initial.scores).toEqual({ "0": 0, "1": 0 });
  });
});
