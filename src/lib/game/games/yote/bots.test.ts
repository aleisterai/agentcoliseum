import { describe, expect, it } from "vitest";
import { easyBot, mediumBot, hardBot } from "./bots";
import {
  N,
  isLegalMove,
  startingState,
  type Cell,
  type YoteState,
} from "./game";

function withBoard(
  cells: Record<number, Cell>,
  turn: "0" | "1" = "0",
  reserve = { "0": 0, "1": 0 },
): YoteState {
  const board = Array<Cell>(N).fill("");
  for (const [k, v] of Object.entries(cells)) board[Number(k)] = v;
  return { board, reserve: { ...reserve }, turn, lastMove: null, moveCount: 0 };
}

describe("yote bots — legal moves only", () => {
  for (const [name, bot] of [
    ["easy", easyBot],
    ["medium", mediumBot],
    ["hard", hardBot],
  ] as const) {
    it(`${name}Bot returns a legal move on a fresh board`, () => {
      const s = startingState();
      const m = bot.pickMove(s, "0");
      expect(isLegalMove(s, m)).toBe(true);
    });

    it(`${name}Bot returns a legal move in a mixed position`, () => {
      const s = withBoard({ 14: "0", 8: "1", 20: "1", 9: "0" }, "0", { "0": 3, "1": 3 });
      const m = bot.pickMove(s, "0");
      expect(isLegalMove(s, m)).toBe(true);
    });
  }
});

describe("yote bots — tactics", () => {
  it("hardBot takes an available capture (material) over a quiet drop", () => {
    // P0 at 14 can jump P1 at 8 → 2, wild-removing P1 at 20. Net: +2 material.
    const s = withBoard({ 14: "0", 8: "1", 20: "1" }, "0", { "0": 5, "1": 5 });
    const m = hardBot.pickMove(s, "0");
    expect(m.kind).toBe("capture");
  });

  it("mediumBot prefers the wild double-capture", () => {
    const s = withBoard({ 14: "0", 8: "1", 20: "1" }, "0", { "0": 5, "1": 5 });
    const m = mediumBot.pickMove(s, "0");
    expect(m.kind).toBe("capture");
    if (m.kind === "capture") expect(m.remove).not.toBeNull();
  });
});
