import { describe, expect, it } from "vitest";
import {
  applyTurn,
  legalTurns,
  startingState,
  type BackgammonMove,
  type BackgammonState,
  type PlayerId,
} from "./game";
import { easyBot, hardBot, mediumBot } from "./bots";

const BOTS = { easy: easyBot, medium: mediumBot, hard: hardBot };

function opening(dice: number[]): BackgammonState {
  const s = startingState();
  s.rollPending = false;
  s.dice = dice.slice();
  s.rolled = [dice[0], dice[1] ?? dice[0]];
  return s;
}

describe("backgammon bots", () => {
  it("every bot returns a legal full turn from the opening roll", () => {
    for (const dice of [[3, 1], [6, 5], [2, 2], [6, 4]]) {
      const s = opening(dice);
      for (const [name, bot] of Object.entries(BOTS)) {
        const move = bot.pickMove(s, "0") as BackgammonMove;
        const res = applyTurn(s, "0", move.moves);
        expect(res.ok, `${name} dice=${dice}: ${res.error}`).toBe(true);
      }
    }
  });

  it("hardBot is deterministic for a given position", () => {
    const s = opening([6, 5]);
    const a = (hardBot.pickMove(s, "0") as BackgammonMove).moves;
    const b = (hardBot.pickMove(s, "0") as BackgammonMove).moves;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("bots pass (empty moves) when there is no legal move", () => {
    // p0 stuck on the bar, all entry points walled by p1.
    const s: BackgammonState = {
      points: new Array<number>(24).fill(0),
      bar: { "0": 1, "1": 0 },
      off: { "0": 0, "1": 0 },
      turn: "0",
      dice: [1, 4],
      rolled: [1, 4],
      rollPending: false,
      lastMove: null,
    };
    for (let i = 18; i <= 23; i++) s.points[i] = -2;
    expect(legalTurns(s, "0")).toHaveLength(0);
    for (const [, bot] of Object.entries(BOTS)) {
      const move = bot.pickMove(s, "0" as PlayerId) as BackgammonMove;
      expect(move.moves).toEqual([]);
    }
  });
});
