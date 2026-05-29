import { describe, expect, it } from "vitest";
import { buildEngine } from "@/lib/game/engine";
import {
  BOARD,
  TOTAL_SHIP_CELLS,
  buildFleet,
  checkResult,
  fleetDestroyed,
  game,
  idx,
  isFireLegal,
  placementCells,
  shipAt,
  shipSunk,
  startingState,
  type BattleshipMove,
  type BattleshipState,
  type PlayerId,
  type ShipPlacement,
} from "./game";
import { battleshipAdapter } from "./index";
import { easyBot, hardBot, mediumBot, randomFleet } from "./bots";

const VALID_FLEET: ShipPlacement[] = [
  { length: 5, row: 0, col: 0, orientation: "h" },
  { length: 4, row: 2, col: 0, orientation: "h" },
  { length: 3, row: 4, col: 0, orientation: "h" },
  { length: 3, row: 6, col: 0, orientation: "v" },
  { length: 2, row: 6, col: 5, orientation: "h" },
];

/** Convert a bot/engine move into (moveName, args) for buildEngine.applyMove. */
function toArgs(m: BattleshipMove): [string, unknown[]] {
  return m.kind === "place"
    ? ["place", [{ kind: "place", ships: m.ships }]]
    : ["fire", [{ row: m.row, col: m.col }]];
}

describe("battleship — placement geometry", () => {
  it("placementCells walks horizontally and vertically", () => {
    expect(placementCells({ length: 3, row: 0, col: 0, orientation: "h" })).toEqual([0, 1, 2]);
    expect(placementCells({ length: 3, row: 0, col: 0, orientation: "v" })).toEqual([0, 10, 20]);
  });
  it("placementCells rejects off-board runs", () => {
    expect(placementCells({ length: 3, row: 0, col: 8, orientation: "h" })).toBeNull();
    expect(placementCells({ length: 3, row: 9, col: 0, orientation: "v" })).toBeNull();
    expect(placementCells({ length: 1, row: -1, col: 0, orientation: "h" })).toBeNull();
  });
});

describe("battleship — buildFleet", () => {
  it("accepts a valid fleet and assigns names by length", () => {
    const b = buildFleet(VALID_FLEET);
    expect(b.ok).toBe(true);
    expect(b.fleet).toHaveLength(5);
    const names = b.fleet!.map((s) => s.name).sort();
    expect(names).toEqual(["Battleship", "Carrier", "Cruiser", "Destroyer", "Submarine"]);
    const totalCells = b.fleet!.reduce((n, s) => n + s.cells.length, 0);
    expect(totalCells).toBe(TOTAL_SHIP_CELLS);
  });
  it("rejects the wrong number of ships", () => {
    expect(buildFleet(VALID_FLEET.slice(0, 4)).ok).toBe(false);
  });
  it("rejects the wrong length multiset", () => {
    const bad = VALID_FLEET.map((p, i) => (i === 0 ? { ...p, length: 2 } : p));
    expect(buildFleet(bad).ok).toBe(false);
  });
  it("rejects overlapping ships", () => {
    const overlap: ShipPlacement[] = [
      { length: 5, row: 0, col: 0, orientation: "h" }, // 0..4
      { length: 4, row: 0, col: 3, orientation: "h" }, // 3..6 overlaps
      { length: 3, row: 4, col: 0, orientation: "h" },
      { length: 3, row: 6, col: 0, orientation: "v" },
      { length: 2, row: 8, col: 0, orientation: "h" },
    ];
    expect(buildFleet(overlap).ok).toBe(false);
  });
  it("allows ships that merely touch", () => {
    const touching: ShipPlacement[] = [
      { length: 5, row: 0, col: 0, orientation: "h" }, // 0..4
      { length: 4, row: 1, col: 0, orientation: "h" }, // 10..13 (touches Carrier below)
      { length: 3, row: 4, col: 0, orientation: "h" }, // 40,41,42
      { length: 3, row: 6, col: 0, orientation: "v" }, // 60,70,80
      { length: 2, row: 8, col: 1, orientation: "h" }, // 81,82 (touches Submarine at 80)
    ];
    expect(buildFleet(touching).ok).toBe(true);
  });
});

describe("battleship — firing helpers", () => {
  function firingState(): BattleshipState {
    const s = startingState();
    s.fleet = { "0": buildFleet(VALID_FLEET).fleet!, "1": buildFleet(VALID_FLEET).fleet! };
    s.placed = { "0": true, "1": true };
    s.phase = "firing";
    s.turn = "0";
    return s;
  }

  it("isFireLegal honours phase, turn, bounds, and no-repeat", () => {
    const s = firingState();
    expect(isFireLegal(s, "0", 5, 5)).toBe(true);
    expect(isFireLegal(s, "1", 5, 5)).toBe(false); // not their turn
    expect(isFireLegal(s, "0", 10, 0)).toBe(false); // off-board
    s.shots["0"][idx(5, 5)] = "miss";
    expect(isFireLegal(s, "0", 5, 5)).toBe(false); // already fired
    s.phase = "placement";
    expect(isFireLegal(s, "0", 1, 1)).toBe(false); // wrong phase
  });

  it("shipAt + shipSunk + fleetDestroyed track damage", () => {
    const s = firingState();
    const carrier = shipAt(s.fleet["1"], idx(0, 0))!;
    expect(carrier.name).toBe("Carrier");
    // Hit every carrier cell in P0's shots.
    for (const c of carrier.cells) s.shots["0"][c] = "hit";
    expect(shipSunk(carrier, s.shots["0"])).toBe(true);
    expect(fleetDestroyed(s.fleet["1"], s.shots["0"])).toBe(false); // others alive
    // Sink the rest.
    for (const sh of s.fleet["1"]) for (const c of sh.cells) s.shots["0"][c] = "hit";
    expect(fleetDestroyed(s.fleet["1"], s.shots["0"])).toBe(true);
    const r = checkResult(s);
    expect(r.status).toBe("win");
    if (r.status === "win") expect(r.winner).toBe("0");
  });
});

describe("battleship — engine integration", () => {
  it("placement order: P0 places, then P1, then firing begins with P0", () => {
    const engine = buildEngine(game);
    const state = engine.initialState();
    expect((state.G as BattleshipState).phase).toBe("placement");
    expect((state.G as BattleshipState).turn).toBe("0");

    const [mn, args] = toArgs({ kind: "place", ships: VALID_FLEET });
    const afterP0 = engine.applyMove(state, "0", mn, args)!;
    expect(afterP0).not.toBeNull();
    expect((afterP0.G as BattleshipState).placed["0"]).toBe(true);
    expect((afterP0.G as BattleshipState).phase).toBe("placement");
    expect((afterP0.G as BattleshipState).turn).toBe("1");

    const afterP1 = engine.applyMove(afterP0, "1", mn, args)!;
    expect(afterP1).not.toBeNull();
    expect((afterP1.G as BattleshipState).phase).toBe("firing");
    expect((afterP1.G as BattleshipState).turn).toBe("0");
  });

  it("rejects an out-of-turn fire and a repeat fire", () => {
    const engine = buildEngine(game);
    let state = engine.initialState();
    const [mn, args] = toArgs({ kind: "place", ships: VALID_FLEET });
    state = engine.applyMove(state, "0", mn, args)!;
    state = engine.applyMove(state, "1", mn, args)!;
    // P1 firing out of turn → rejected.
    expect(engine.applyMove(state, "1", "fire", [{ row: 5, col: 5 }])).toBeNull();
    // P0 fires legally.
    const afterFire = engine.applyMove(state, "0", "fire", [{ row: 5, col: 5 }])!;
    expect(afterFire).not.toBeNull();
    expect((afterFire.G as BattleshipState).turn).toBe("1");
    // P1 fires, then P0 can't repeat the same cell.
    const afterP1Fire = engine.applyMove(afterFire, "1", "fire", [{ row: 0, col: 0 }])!;
    expect(engine.applyMove(afterP1Fire, "0", "fire", [{ row: 5, col: 5 }])).toBeNull();
  });

  it("plays a full hard-vs-hard game to a winner (e2e)", () => {
    const engine = buildEngine(game);
    let state = engine.initialState();
    let over = engine.gameOver(state);
    let plies = 0;
    while (!over && plies < 400) {
      const G = state.G as BattleshipState;
      const mover: PlayerId = G.turn;
      const bot = mover === "0" ? hardBot : mediumBot;
      const move = bot.pickMove(G, mover);
      const [mn, args] = toArgs(move);
      const next = engine.applyMove(state, mover, mn, args);
      expect(next, `engine rejected a legal ${move.kind} by P${mover} at ply ${plies}`).not.toBeNull();
      state = next!;
      over = engine.gameOver(state);
      plies += 1;
    }
    expect(over).not.toBeNull();
    const g = state.G as BattleshipState;
    // The winner's shots destroyed the loser's whole fleet.
    const winnerDestroyedFoe =
      fleetDestroyed(g.fleet["1"], g.shots["0"]) || fleetDestroyed(g.fleet["0"], g.shots["1"]);
    expect(winnerDestroyedFoe).toBe(true);
  });
});

describe("battleship — adapter", () => {
  it("validateMovePayload accepts a legal place + fire and rejects junk", () => {
    expect(battleshipAdapter.validateMovePayload({ kind: "place", ships: VALID_FLEET }).ok).toBe(true);
    expect(battleshipAdapter.validateMovePayload({ kind: "fire", row: 3, col: 4 }).ok).toBe(true);
    expect(battleshipAdapter.validateMovePayload({ kind: "fire", row: 10, col: 0 }).ok).toBe(false);
    expect(battleshipAdapter.validateMovePayload({ kind: "place", ships: VALID_FLEET.slice(0, 3) }).ok).toBe(false);
    expect(battleshipAdapter.validateMovePayload({ kind: "nope" }).ok).toBe(false);
  });

  it("serializeForSpectator hides fleets but reveals the viewer's own", () => {
    const s = startingState();
    s.fleet = { "0": buildFleet(VALID_FLEET).fleet!, "1": buildFleet(VALID_FLEET).fleet! };
    s.placed = { "0": true, "1": true };
    s.phase = "firing";

    const spec = battleshipAdapter.serializeForSpectator(s, "spectator", false);
    const pub = spec.publicState as BattleshipState;
    expect(pub.fleet["0"]).toHaveLength(0);
    expect(pub.fleet["1"]).toHaveLength(0);
    expect(spec.privateAddendum).toBeUndefined();

    const p0view = battleshipAdapter.serializeForSpectator(s, "0", false);
    expect((p0view.publicState as BattleshipState).fleet["1"]).toHaveLength(0);
    expect((p0view.privateAddendum as { myFleet: unknown[] }).myFleet).toHaveLength(5);

    // At game over both fleets are revealed.
    const done = battleshipAdapter.serializeForSpectator(s, "spectator", true);
    expect((done.publicState as BattleshipState).fleet["0"]).toHaveLength(5);
  });

  it("clock budget is in sync with the 240s default", () => {
    expect(battleshipAdapter.clockBudgetMs).toBe(240 * 1000);
    expect(battleshipAdapter.perfectInformation).toBe(false);
    expect(battleshipAdapter.id).toBe("battleship");
  });
});

describe("battleship — bots", () => {
  it("randomFleet always produces a legal fleet", () => {
    for (let i = 0; i < 50; i++) {
      const f = randomFleet(i % 2 === 0);
      expect(buildFleet(f).ok, `iteration ${i}`).toBe(true);
    }
  });
  it("every bot returns a legal fire during firing", () => {
    const s = startingState();
    s.fleet = { "0": buildFleet(VALID_FLEET).fleet!, "1": buildFleet(VALID_FLEET).fleet! };
    s.placed = { "0": true, "1": true };
    s.phase = "firing";
    s.turn = "0";
    for (const bot of [easyBot, mediumBot, hardBot]) {
      const m = bot.pickMove(s, "0");
      expect(m.kind).toBe("fire");
      if (m.kind === "fire") expect(isFireLegal(s, "0", m.row, m.col)).toBe(true);
    }
  });
  it("bounds: BOARD is 10", () => {
    expect(BOARD).toBe(10);
  });
});
