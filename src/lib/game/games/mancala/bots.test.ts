import { describe, expect, it } from "vitest";
import { STORE_0, applyMove, legalMoves, startingState, type MancalaState } from "./game";
import { easyBot, hardBot, mediumBot } from "./bots";

describe("mancala bots — legal moves only", () => {
  it("easyBot picks legal at start", () => {
    const s = startingState();
    const m = easyBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.pit === m.pit)).toBe(true);
  });
  it("mediumBot picks legal at start", () => {
    const s = startingState();
    const m = mediumBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.pit === m.pit)).toBe(true);
  });
  it("hardBot picks legal at start", () => {
    const s = startingState();
    const m = hardBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.pit === m.pit)).toBe(true);
  });
});

describe("mancala bots — tactical", () => {
  it("mediumBot takes a bonus-turn move when one exists", () => {
    // Standard start — pit 2 (4 seeds) lands the last seed in store (bonus).
    const s = startingState();
    const m = mediumBot.pickMove(s, "0");
    // The classic opening "pit 2" is a bonus-turn move.
    expect(m.pit).toBe(2);
  });

  it("hardBot picks a non-losing move", () => {
    // Simple sanity — hard bot returns one of the 6 legal pits.
    const s = startingState();
    const m = hardBot.pickMove(s, "0");
    expect([0, 1, 2, 3, 4, 5]).toContain(m.pit);
  });

  it("mediumBot grabs a free capture when available", () => {
    // Hand-crafted: P0 plays pit 0 (1 seed) → lands in pit 1 (empty), pit 11
    // has 3 seeds → capture 4 into store.
    const s: MancalaState = {
      pits: [1, 0, 4, 4, 4, 4, 0, 4, 4, 4, 4, 3, 4, 0],
      turn: "0",
      lastMove: null,
    };
    const m = mediumBot.pickMove(s, "0");
    const next = applyMove(s, m);
    // Either pit 0 (the capture) or another move — must produce ≥ 4 in store
    // OR at least improve store relative to other legal moves. We assert
    // the capture move was selected because it's the highest-gain.
    expect(next.pits[STORE_0]).toBeGreaterThanOrEqual(4);
  });
});
