import { describe, expect, it } from "vitest";
import { buildEngine } from "@/lib/game/engine";
import {
  CENTER,
  MAX_MOVES,
  N,
  NEIGHBORS,
  OUTER,
  RING,
  RING1,
  applyMove,
  checkResult,
  game,
  hasLegalMove,
  isCenteredAndGuarded,
  isLegalMove,
  legalMoves,
  queenCell,
  startingState,
  type AgonMove,
  type AgonState,
  type Cell,
  type PlayerId,
} from "./game";
import { agonAdapter } from "./index";
import { hardBot } from "./bots";

function mk(cells: Record<number, Cell>, turn: PlayerId = "0", moveCount = 0): AgonState {
  const board = Array<Cell>(N).fill("");
  for (const [k, v] of Object.entries(cells)) board[Number(k)] = v;
  return { board, turn, lastMove: null, moveCount };
}

function countCell(s: AgonState, c: Cell): number {
  return s.board.filter((x) => x === c).length;
}

/** A colinear triple X→B→C (same direction) plus a mover origin P adjacent to
 *  X that can legally step into X (inward or same ring). */
function findFlank(): { X: number; B: number; C: number; P: number } {
  for (let X = 0; X < N; X++) {
    for (let d = 0; d < 6; d++) {
      const B = NEIGHBORS[X][d];
      if (B < 0) continue;
      const C = NEIGHBORS[B][d];
      if (C < 0) continue;
      for (const P of NEIGHBORS[X]) {
        if (P < 0 || P === B || P === C) continue;
        if (RING[P] < RING[X]) continue; // P→X must be inward/same-ring
        return { X, B, C, P };
      }
    }
  }
  throw new Error("no flank scenario found");
}

describe("agon — board geometry", () => {
  it("has 91 cells across 6 rings of the right sizes", () => {
    expect(N).toBe(91);
    const sizes = [0, 0, 0, 0, 0, 0];
    for (const r of RING) sizes[r] += 1;
    expect(sizes).toEqual([1, 6, 12, 18, 24, 30]);
    expect(RING[CENTER]).toBe(0);
    expect(RING1).toHaveLength(6);
    expect(RING1.every((i) => RING[i] === 1)).toBe(true);
    expect(OUTER).toHaveLength(30);
    expect(OUTER.every((i) => RING[i] === 5)).toBe(true);
  });

  it("adjacency is symmetric", () => {
    for (let a = 0; a < N; a++) {
      for (const b of NEIGHBORS[a]) {
        if (b >= 0) expect(NEIGHBORS[b]).toContain(a);
      }
    }
  });
});

describe("agon — setup", () => {
  it("starts each side with 1 queen + 6 guards on the outer ring", () => {
    const s = startingState();
    expect(countCell(s, "0Q")).toBe(1);
    expect(countCell(s, "0G")).toBe(6);
    expect(countCell(s, "1Q")).toBe(1);
    expect(countCell(s, "1G")).toBe(6);
    const onOuter = (p: PlayerId) =>
      s.board.every((c, i) => (c[0] === p ? RING[i] === 5 : true));
    expect(onOuter("0")).toBe(true);
    expect(onOuter("1")).toBe(true);
  });
});

describe("agon — movement", () => {
  it("only allows inward or same-ring steps to an empty adjacent cell", () => {
    const s = startingState();
    for (const m of legalMoves(s, "0")) {
      expect(RING[m.to]).toBeLessThanOrEqual(RING[m.from]);
      expect(s.board[m.to]).toBe("");
      expect(NEIGHBORS[m.from]).toContain(m.to);
    }
  });

  it("rejects a step that moves farther from the centre", () => {
    // Find an inner cell with an outward neighbour.
    let inner = -1;
    let outward = -1;
    for (let c = 0; c < N && inner < 0; c++) {
      for (const nb of NEIGHBORS[c]) {
        if (nb >= 0 && RING[nb] === RING[c] + 1) {
          inner = c;
          outward = nb;
          break;
        }
      }
    }
    expect(inner).toBeGreaterThanOrEqual(0);
    const s = mk({ [inner]: "0G" });
    expect(isLegalMove(s, "0", { from: inner, to: outward })).toBe(false);
  });
});

describe("agon — flanking", () => {
  it("sends a flanked guard back to the outer ring (stays in play)", () => {
    const { X, B, C, P } = findFlank();
    const s = mk({ [P]: "0G", [B]: "1G", [C]: "0G" });
    const next = applyMove(s, "0", { from: P, to: X });
    expect(next.lastMove?.flanked).toContain(B);
    expect(next.board[B]).toBe(""); // vacated
    expect(countCell(next, "1G")).toBe(1); // not removed from play
    const survivor = next.board.findIndex((c) => c === "1G");
    expect(RING[survivor]).toBe(5); // relocated to the rim
  });

  it("capturing the enemy queen by flank wins immediately", () => {
    const { X, B, C, P } = findFlank();
    // Park a friendly queen somewhere harmless so player 0 still has one.
    const home = OUTER.find((i) => i !== X && i !== B && i !== C && i !== P) as number;
    const s = mk({ [P]: "0G", [B]: "1Q", [C]: "0G", [home]: "0Q" });
    const next = applyMove(s, "0", { from: P, to: X });
    expect(next.lastMove?.flanked).toContain(B);
    expect(queenCell(next, "1")).toBe(-1);
    expect(checkResult(next)).toEqual({ status: "win", winner: "0" });
  });

  it("moving your own piece between two enemies is safe", () => {
    // X with two opposite enemy neighbours; a mover P that can step into X.
    let found: { X: number; E1: number; E2: number; P: number } | null = null;
    for (let X = 0; X < N && !found; X++) {
      for (let d = 0; d < 3; d++) {
        const E1 = NEIGHBORS[X][d];
        const E2 = NEIGHBORS[X][(d + 3) % 6];
        if (E1 < 0 || E2 < 0) continue;
        for (const P of NEIGHBORS[X]) {
          if (P < 0 || P === E1 || P === E2) continue;
          if (RING[P] < RING[X]) continue;
          found = { X, E1, E2, P };
          break;
        }
        if (found) break;
      }
    }
    expect(found).not.toBeNull();
    const { X, E1, E2, P } = found!;
    const s = mk({ [P]: "0G", [E1]: "1G", [E2]: "1G" });
    const next = applyMove(s, "0", { from: P, to: X });
    expect(next.lastMove?.flanked).toEqual([]);
    expect(next.board[E1]).toBe("1G");
    expect(next.board[E2]).toBe("1G");
  });
});

describe("agon — termination", () => {
  it("queen on the centre ringed by her guards wins", () => {
    const cells: Record<number, Cell> = { [CENTER]: "0Q" };
    for (const i of RING1) cells[i] = "0G";
    const homeForFoe = OUTER[0];
    cells[homeForFoe] = "1Q";
    const s = mk(cells, "1");
    expect(isCenteredAndGuarded(s, "0")).toBe(true);
    expect(checkResult(s)).toEqual({ status: "win", winner: "0" });
  });

  it("a player to move with no legal move loses", () => {
    // Player 1's only piece is its queen on the centre — every neighbour is
    // outward (ring 1), so it can never move. Player 0 keeps a queen elsewhere.
    const s = mk({ [CENTER]: "1Q", [OUTER[0]]: "0Q" }, "1");
    expect(hasLegalMove(s, "1")).toBe(false);
    expect(checkResult(s)).toEqual({ status: "win", winner: "0" });
  });
});

describe("agon — adapter", () => {
  it("validateMovePayload accepts {from,to}, rejects junk", () => {
    expect(agonAdapter.validateMovePayload({ from: 64, to: 48 }).ok).toBe(true);
    expect(agonAdapter.validateMovePayload({ from: 0, to: 90 }).ok).toBe(true);
    expect(agonAdapter.validateMovePayload({ from: -1, to: 4 }).ok).toBe(false);
    expect(agonAdapter.validateMovePayload({ from: 4, to: 91 }).ok).toBe(false);
    expect(agonAdapter.validateMovePayload({ from: 4 }).ok).toBe(false);
    expect(agonAdapter.validateMovePayload({ nope: 1 }).ok).toBe(false);
  });

  it("clock + perfect-info wiring", () => {
    expect(agonAdapter.clockBudgetMs).toBe(240 * 1000);
    expect(agonAdapter.perfectInformation).toBe(true);
    expect(agonAdapter.id).toBe("agon");
  });
});

describe("agon — engine self-play (e2e, deterministic)", () => {
  it("plays a full hard-vs-hard game to a terminal result", () => {
    const engine = buildEngine(game);
    let state = engine.initialState();
    let over = engine.gameOver(state);
    let plies = 0;
    while (!over && plies < MAX_MOVES + 2) {
      const G = state.G as AgonState;
      const mover: PlayerId = G.turn;
      const move = hardBot.pickMove(G, mover) as AgonMove;
      const next = engine.applyMove(state, mover, "play", [move]);
      expect(next, `engine rejected bot move at ply ${plies}: ${JSON.stringify(move)}`).not.toBeNull();
      state = next!;
      over = engine.gameOver(state);
      plies += 1;
    }
    expect(over).not.toBeNull();
    const result = checkResult(state.G as AgonState);
    expect(result.status === "win" || result.status === "draw").toBe(true);
  });
});
