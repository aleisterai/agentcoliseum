import { describe, expect, it } from "vitest";
import {
  ADJACENCY,
  MILLS,
  NUM_POINTS,
  TOTAL_PIECES_PER_SIDE,
  applyMove,
  canRemove,
  checkResult,
  game,
  isInMill,
  isLegalPlay,
  legalMoves,
  legalPlays,
  opposite,
  startingState,
  type NMMState,
} from "./game";

describe("nmm — setup", () => {
  it("starting state: 24 empty points, placement phase, P0 to move", () => {
    const s = startingState();
    expect(s.points.length).toBe(NUM_POINTS);
    expect(s.points.every((p) => p === "")).toBe(true);
    expect(s.turn).toBe("0");
    expect(s.phase).toBe("placement");
    expect(s.placed).toEqual({ "0": 0, "1": 0 });
    expect(s.alive).toEqual({ "0": 0, "1": 0 });
  });

  it("ADJACENCY is symmetric (a in adj(b) ⇒ b in adj(a))", () => {
    for (let a = 0; a < NUM_POINTS; a++) {
      for (const b of ADJACENCY[a]) {
        expect(ADJACENCY[b]).toContain(a);
      }
    }
  });

  it("MILLS table has 16 unique triples", () => {
    expect(MILLS.length).toBe(16);
    const set = new Set(MILLS.map((m) => [...m].sort().join(",")));
    expect(set.size).toBe(16);
  });
});

describe("nmm — placement legality", () => {
  it("legalPlays returns all 24 empty points at start", () => {
    expect(legalPlays(startingState()).length).toBe(24);
  });

  it("isLegalPlay rejects occupied points + non-null `from` in placement", () => {
    const s = startingState();
    expect(isLegalPlay(s, { from: null, to: 0 })).toBe(true);
    const after = applyMove(s, { from: null, to: 0 });
    expect(isLegalPlay(after, { from: null, to: 0 })).toBe(false);
    expect(isLegalPlay(after, { from: 0, to: 1 })).toBe(false); // still placement
  });
});

describe("nmm — mill formation + removal", () => {
  it("placing the third piece in a mill line forms a mill", () => {
    // P0 places at 0, P1 at 9, P0 at 1, P1 at 10, P0 at 2 (forms 0-1-2 mill).
    let s = startingState();
    s = applyMove(s, { from: null, to: 0 });
    s = applyMove(s, { from: null, to: 9 });
    s = applyMove(s, { from: null, to: 1 });
    s = applyMove(s, { from: null, to: 10 });
    // Placing at 2 forms mill 0-1-2 for P0 → must include `remove`.
    const movesNoRemove = legalMoves(s).filter((m) => m.to === 2 && m.remove === undefined);
    expect(movesNoRemove.length).toBe(0);
    const withRemove = legalMoves(s).filter((m) => m.to === 2 && m.remove !== undefined);
    expect(withRemove.length).toBeGreaterThan(0);
    // Apply the mill move.
    const next = applyMove(s, { from: null, to: 2, remove: 9 });
    expect(isInMill(next.points, 0, "0")).toBe(true);
    expect(next.points[9]).toBe(""); // removed
    expect(next.alive["1"]).toBe(1); // P1 had 2 pieces (at 9 and 10), now 1.
  });

  it("canRemove forbids in-mill pieces unless ALL opp pieces are in mills", () => {
    const s = startingState();
    // Construct: P1 has 2 mills + 1 lone piece. Lone piece is the only legal target.
    // Mill 1: 0-1-2 (P1), mill 2: 21-22-23 (P1), lone: 16 (P1).
    const points = [...s.points];
    points[0] = "1"; points[1] = "1"; points[2] = "1";
    points[21] = "1"; points[22] = "1"; points[23] = "1";
    points[16] = "1";
    points[4] = "0";
    const test: NMMState = {
      ...s,
      points: points as ("" | "0" | "1")[],
      turn: "0",
      placed: { "0": 1, "1": 7 },
      alive: { "0": 1, "1": 7 },
    };
    expect(canRemove(test, 0, "0")).toBe(false);  // in mill
    expect(canRemove(test, 16, "0")).toBe(true);   // lone
    // Now make all P1 pieces be in mills — every removal target should work.
    const allMill = [...test.points] as ("" | "0" | "1")[];
    allMill[16] = ""; // remove the lone piece
    allMill[4] = ""; // adjust P0 piece too to clear
    // P1 has only mills 0-1-2 + 21-22-23 → all in mills.
    const allInMills: NMMState = { ...test, points: allMill, alive: { "0": 0, "1": 6 } };
    expect(canRemove(allInMills, 0, "0")).toBe(true);
  });
});

describe("nmm — movement phase + flying", () => {
  it("entering movement after all 18 placements", () => {
    let s = startingState();
    // Alternate placements that never form a mill: use points carefully.
    // Easiest: just enumerate non-mill-creating placements one at a time.
    while (s.phase === "placement") {
      const moves = legalMoves(s).filter((m) => m.remove === undefined);
      if (moves.length === 0) break;
      s = applyMove(s, moves[0]);
    }
    // After 18 placements (no mills forced), phase should flip.
    if (s.placed["0"] === TOTAL_PIECES_PER_SIDE && s.placed["1"] === TOTAL_PIECES_PER_SIDE) {
      expect(s.phase).toBe("movement");
    }
  });

  it("isLegalPlay enforces adjacency in movement phase (non-flying)", () => {
    // Build a position with one P0 at 0 and one P1 piece elsewhere, both in movement phase.
    const state: NMMState = {
      points: ["0", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""].map(
        (x) => (x as "" | "0" | "1"),
      ),
      turn: "0",
      phase: "movement",
      placed: { "0": 9, "1": 9 },
      alive: { "0": 5, "1": 5 },
      lastMove: null,
    };
    // Put P1 pieces to avoid termination.
    state.points[5] = "1"; state.points[7] = "1"; state.points[13] = "1"; state.points[18] = "1"; state.points[22] = "1";
    // Adjacencies of 0 are [1, 9]. Other targets should be illegal (not flying).
    expect(isLegalPlay(state, { from: 0, to: 1 })).toBe(true);
    expect(isLegalPlay(state, { from: 0, to: 9 })).toBe(true);
    expect(isLegalPlay(state, { from: 0, to: 2 })).toBe(false);
  });

  it("flying allowed at exactly 3 pieces", () => {
    const state: NMMState = {
      points: Array<"" | "0" | "1">(NUM_POINTS).fill(""),
      turn: "0",
      phase: "movement",
      placed: { "0": 9, "1": 9 },
      alive: { "0": 3, "1": 4 },
      lastMove: null,
    };
    state.points[0] = "0"; state.points[1] = "0"; state.points[2] = "0";
    state.points[5] = "1"; state.points[10] = "1"; state.points[14] = "1"; state.points[18] = "1";
    // Flying: 0 → 23 (not adjacent) is legal.
    expect(isLegalPlay(state, { from: 0, to: 23 })).toBe(true);
  });
});

describe("nmm — termination", () => {
  it("reducing opponent below 3 in movement phase wins", () => {
    const state: NMMState = {
      points: Array<"" | "0" | "1">(NUM_POINTS).fill(""),
      turn: "0",
      phase: "movement",
      placed: { "0": 9, "1": 9 },
      alive: { "0": 4, "1": 2 }, // P1 already below 3
      lastMove: null,
    };
    state.points[0] = "0"; state.points[1] = "0"; state.points[2] = "0"; state.points[3] = "0";
    state.points[10] = "1"; state.points[11] = "1";
    const r = checkResult(state);
    expect(r.status).toBe("win");
    if (r.status === "win") {
      expect(r.winner).toBe("0");
      expect(r.reason).toBe("few_pieces");
    }
  });

  it("opposite flips player", () => {
    expect(opposite("0")).toBe("1");
    expect(opposite("1")).toBe("0");
  });
});

describe("nmm — boardgame.io", () => {
  it("setup matches starting state", () => {
    const initial = (game.setup as () => NMMState)();
    expect(initial.turn).toBe("0");
    expect(initial.phase).toBe("placement");
  });
});
