import { describe, expect, it } from "vitest";
import {
  buildFleet,
  idx,
  isFireLegal,
  rowOf,
  colOf,
  startingState,
  type BattleshipState,
  type ShipPlacement,
} from "./game";
import { easyBot, hardBot, mediumBot, randomFleet } from "./bots";

const VALID_FLEET: ShipPlacement[] = [
  { length: 5, row: 0, col: 0, orientation: "h" },
  { length: 4, row: 2, col: 0, orientation: "h" },
  { length: 3, row: 4, col: 0, orientation: "h" },
  { length: 3, row: 6, col: 0, orientation: "v" },
  { length: 2, row: 6, col: 5, orientation: "h" },
];

function firingState(): BattleshipState {
  const s = startingState();
  s.fleet = { "0": buildFleet(VALID_FLEET).fleet!, "1": buildFleet(VALID_FLEET).fleet! };
  s.placed = { "0": true, "1": true };
  s.phase = "firing";
  s.turn = "0";
  return s;
}

describe("battleship bots — placement", () => {
  it("all three bots place a legal fleet", () => {
    for (const bot of [easyBot, mediumBot, hardBot]) {
      const s = startingState(); // placement phase, P0 to move
      const m = bot.pickMove(s, "0");
      expect(m.kind).toBe("place");
      if (m.kind === "place") expect(buildFleet(m.ships).ok).toBe(true);
    }
  });
  it("randomFleet(spread) stays legal", () => {
    for (let i = 0; i < 30; i++) expect(buildFleet(randomFleet(true)).ok).toBe(true);
  });
});

describe("battleship bots — hunt/target", () => {
  it("medium + hard target a neighbour of a fresh hit", () => {
    const around = (i: number) => {
      const r = rowOf(i);
      const c = colOf(i);
      return new Set(
        [idx(r - 1, c), idx(r + 1, c), idx(r, c - 1), idx(r, c + 1)].filter(
          (n) => n >= 0 && n < 100,
        ),
      );
    };
    for (const bot of [mediumBot, hardBot]) {
      const s = firingState();
      const hit = idx(5, 5);
      s.shots["0"][hit] = "hit"; // lone hit with all neighbours open
      const m = bot.pickMove(s, "0");
      expect(m.kind).toBe("fire");
      if (m.kind === "fire") {
        const target = idx(m.row, m.col);
        expect(around(hit).has(target), `bot should target adjacent to the hit`).toBe(true);
        expect(isFireLegal(s, "0", m.row, m.col)).toBe(true);
      }
    }
  });

  it("easy bot fires a legal (possibly random) cell", () => {
    const s = firingState();
    const m = easyBot.pickMove(s, "0");
    expect(m.kind).toBe("fire");
    if (m.kind === "fire") expect(isFireLegal(s, "0", m.row, m.col)).toBe(true);
  });
});
