import { describe, expect, it } from "vitest";
import {
  N,
  NEIGHBORS,
  OUTER,
  RING,
  applyMove,
  isLegalMove,
  queenCell,
  startingState,
  type AgonMove,
  type AgonState,
  type Cell,
  type PlayerId,
} from "./game";
import { easyBot, hardBot, mediumBot } from "./bots";

const BOTS = { easy: easyBot, medium: mediumBot, hard: hardBot };

function mk(cells: Record<number, Cell>, turn: PlayerId = "0"): AgonState {
  const board = Array<Cell>(N).fill("");
  for (const [k, v] of Object.entries(cells)) board[Number(k)] = v;
  return { board, turn, lastMove: null, moveCount: 0 };
}

function findFlank(): { X: number; B: number; C: number; P: number } {
  for (let X = 0; X < N; X++) {
    for (let d = 0; d < 6; d++) {
      const B = NEIGHBORS[X][d];
      if (B < 0) continue;
      const C = NEIGHBORS[B][d];
      if (C < 0) continue;
      for (const P of NEIGHBORS[X]) {
        if (P < 0 || P === B || P === C) continue;
        if (RING[P] < RING[X]) continue;
        return { X, B, C, P };
      }
    }
  }
  throw new Error("no flank scenario");
}

describe("agon bots", () => {
  it("every bot makes a legal opening move", () => {
    const s = startingState();
    for (const [name, bot] of Object.entries(BOTS)) {
      const move = bot.pickMove(s, "0") as AgonMove;
      expect(isLegalMove(s, "0", move), name).toBe(true);
    }
  });

  it("hardBot is deterministic for a given position", () => {
    const s = startingState();
    const a = JSON.stringify(hardBot.pickMove(s, "0"));
    const b = JSON.stringify(hardBot.pickMove(s, "0"));
    expect(a).toBe(b);
  });

  it("hardBot takes an immediate queen-capture flank", () => {
    const { X, B, C, P } = findFlank();
    const home = OUTER.find((i) => i !== X && i !== B && i !== C && i !== P) as number;
    const s = mk({ [P]: "0G", [B]: "1Q", [C]: "0G", [home]: "0Q" });
    const move = hardBot.pickMove(s, "0") as AgonMove;
    const after = applyMove(s, "0", move);
    expect(queenCell(after, "1")).toBe(-1);
  });
});
