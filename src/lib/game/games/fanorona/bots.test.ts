import { describe, expect, it } from "vitest";
import {
  applyTurn,
  hasAnyCapture,
  N,
  startingState,
  type Cell,
  type FanoronaMove,
  type FanoronaState,
  type PlayerId,
} from "./game";
import { easyBot, hardBot, mediumBot } from "./bots";

const BOTS = { easy: easyBot, medium: mediumBot, hard: hardBot };

function mk(cells: Record<number, Cell>, turn: PlayerId = "0"): FanoronaState {
  const board = Array<Cell>(N).fill("");
  for (const [k, v] of Object.entries(cells)) board[Number(k)] = v;
  return { board, turn, lastMove: null, moveCount: 0 };
}

describe("fanorona bots", () => {
  it("every bot makes a legal forced capture from the opening", () => {
    const s = startingState();
    expect(hasAnyCapture(s, "0")).toBe(true);
    for (const [name, bot] of Object.entries(BOTS)) {
      const move = bot.pickMove(s, "0") as FanoronaMove;
      const res = applyTurn(s, "0", move);
      expect(res.ok, `${name}: ${res.ok ? "" : res.error}`).toBe(true);
      if (!res.ok) continue;
      // A capture is mandatory here, so the bot must have taken at least one.
      expect(res.next.lastMove?.captured ?? 0).toBeGreaterThanOrEqual(1);
    }
  });

  it("hardBot is deterministic for a given position", () => {
    const s = startingState();
    const a = JSON.stringify(hardBot.pickMove(s, "0"));
    const b = JSON.stringify(hardBot.pickMove(s, "0"));
    expect(a).toBe(b);
  });

  it("bots play a single paika when no capture exists", () => {
    const s = mk({ 22: "0", 0: "1" }); // lone pieces, nothing to capture
    expect(hasAnyCapture(s, "0")).toBe(false);
    for (const [name, bot] of Object.entries(BOTS)) {
      const move = bot.pickMove(s, "0") as FanoronaMove;
      expect(move.steps, name).toHaveLength(1);
      expect(move.steps[0].capture, name).toBeNull();
      expect(applyTurn(s, "0", move).ok, name).toBe(true);
    }
  });
});
