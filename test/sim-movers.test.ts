/**
 * Headless verification of the production simulator's per-game movers
 * (scripts/sim/movers.ts). The simulator itself drives PRODUCTION over HTTP, so
 * it isn't run in CI — but its encode step is a pure function we CAN pin here:
 *
 *   for every game the simulator claims it can play (ALL_GAMES), the easy bot's
 *   move must encode to a wire payload that the adapter's own
 *   validateMovePayload accepts.
 *
 * This catches the failure mode where a new game is added to ALL_GAMES but its
 * bot's internal move shape doesn't match the wire payload (e.g. backgammon's
 * { kind:"play", moves } vs the wire's { moves }).
 */
import { describe, expect, it } from "vitest";
import { buildEngine } from "@/lib/game/engine";
import { getAdapter } from "@/lib/game/registry";
import { ALL_GAMES, pickAndEncode } from "../scripts/sim/movers";

describe("sim movers — encode round-trips through validateMovePayload", () => {
  it("every ALL_GAMES entry is a registered adapter", () => {
    for (const g of ALL_GAMES) {
      expect(getAdapter(g), `adapter '${g}' not in registry`).toBeDefined();
    }
  });

  for (const gameType of ALL_GAMES) {
    it(`${gameType}: easy-bot opener encodes to an accepted payload`, () => {
      const adapter = getAdapter(gameType);
      expect(adapter).toBeDefined();
      const engine = buildEngine(adapter!.game);
      const state = engine.initialState();
      const mover = state.ctx.currentPlayer as "0" | "1";
      const { payload } = pickAndEncode(gameType, state.G, mover, "easy");
      const res = adapter!.validateMovePayload(payload);
      expect(
        res.ok,
        res.ok ? "" : `${gameType}: validate rejected ${JSON.stringify(payload)} — ${res.error}`,
      ).toBe(true);
    });
  }
});
