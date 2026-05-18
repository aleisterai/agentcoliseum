import { describe, expect, it } from "vitest";
import {
  PITS_PER_SIDE,
  STORE_0,
  STORE_1,
  TOTAL_PITS,
  applyMove,
  checkResult,
  game,
  isLegalMove,
  legalMoves,
  opposite,
  oppositePit,
  ownsPit,
  startingState,
  storeOf,
  opponentStoreOf,
  type MancalaState,
} from "./game";

describe("mancala — setup", () => {
  it("starts with 4 seeds in each of 12 pits, stores empty", () => {
    const s = startingState();
    expect(s.pits.length).toBe(TOTAL_PITS);
    for (let i = 0; i < PITS_PER_SIDE; i++) expect(s.pits[i]).toBe(4);
    for (let i = PITS_PER_SIDE + 1; i < STORE_1; i++) expect(s.pits[i]).toBe(4);
    expect(s.pits[STORE_0]).toBe(0);
    expect(s.pits[STORE_1]).toBe(0);
    expect(s.turn).toBe("0");
  });

  it("ownsPit / storeOf / opposite identify board geometry", () => {
    expect(ownsPit(0, "0")).toBe(true);
    expect(ownsPit(5, "0")).toBe(true);
    expect(ownsPit(6, "0")).toBe(false); // store
    expect(ownsPit(7, "1")).toBe(true);
    expect(ownsPit(12, "1")).toBe(true);
    expect(ownsPit(13, "1")).toBe(false); // store
    expect(storeOf("0")).toBe(STORE_0);
    expect(storeOf("1")).toBe(STORE_1);
    expect(opponentStoreOf("0")).toBe(STORE_1);
    expect(opposite("0")).toBe("1");
  });

  it("oppositePit pairs are correct", () => {
    expect(oppositePit(0)).toBe(12);
    expect(oppositePit(5)).toBe(7);
    expect(oppositePit(7)).toBe(5);
    expect(oppositePit(12)).toBe(0);
    expect(oppositePit(STORE_0)).toBe(-1);
    expect(oppositePit(STORE_1)).toBe(-1);
  });

  it("starting position has 6 legal moves for P0", () => {
    expect(legalMoves(startingState()).length).toBe(6);
  });
});

describe("mancala — sowing", () => {
  it("sowing 4 seeds from pit 2 distributes to 3,4,5,6 (own store)", () => {
    const s = applyMove(startingState(), { pit: 2 });
    expect(s.pits[2]).toBe(0);
    expect(s.pits[3]).toBe(5);
    expect(s.pits[4]).toBe(5);
    expect(s.pits[5]).toBe(5);
    expect(s.pits[STORE_0]).toBe(1);
    // Bonus turn — P0 plays again.
    expect(s.turn).toBe("0");
  });

  it("sowing skips opponent's store", () => {
    // Build a position where a play would wrap past index 13.
    // Put 9 seeds in pit 5 (P0). Sowing wraps:
    //   6 (store) → 7,8,9,10,11,12 (P1 pits) → skip 13 → 0,1
    //   That's 1 (store) + 6 + 2 = 9 sown.
    const s: MancalaState = {
      pits: [4, 4, 4, 4, 4, 9, 0, 4, 4, 4, 4, 4, 4, 0],
      turn: "0",
      lastMove: null,
    };
    const next = applyMove(s, { pit: 5 });
    expect(next.pits[STORE_0]).toBe(1);
    expect(next.pits[7]).toBe(5);
    expect(next.pits[12]).toBe(5);
    expect(next.pits[STORE_1]).toBe(0); // skipped
    expect(next.pits[0]).toBe(5);
    expect(next.pits[1]).toBe(5);
    expect(next.pits[5]).toBe(0);
  });

  it("bonus turn when last seed lands in own store", () => {
    // Pit 5 has 1 seed → sowing puts the only seed in store 6 → bonus.
    const s: MancalaState = {
      pits: [4, 4, 4, 4, 4, 1, 0, 4, 4, 4, 4, 4, 4, 0],
      turn: "0",
      lastMove: null,
    };
    const next = applyMove(s, { pit: 5 });
    expect(next.pits[STORE_0]).toBe(1);
    expect(next.turn).toBe("0");
  });
});

describe("mancala — captures", () => {
  it("capture: last seed lands in empty own pit, takes opposite seeds", () => {
    // Build: pit 0 has 1 seed, pit 1 is empty, pit 11 (opposite of 1) has 3 seeds.
    // P0 plays pit 0 → seed lands in pit 1 (empty, owned). Captures 3+1 = 4.
    const s: MancalaState = {
      pits: [1, 0, 4, 4, 4, 4, 0, 4, 4, 4, 4, 3, 4, 0],
      turn: "0",
      lastMove: null,
    };
    const next = applyMove(s, { pit: 0 });
    expect(next.pits[1]).toBe(0);
    expect(next.pits[11]).toBe(0);
    expect(next.pits[STORE_0]).toBe(4);
    expect(next.lastMove?.captured).toBe(4);
  });

  it("no capture if opposite pit is empty", () => {
    const s: MancalaState = {
      pits: [1, 0, 4, 4, 4, 4, 0, 4, 4, 4, 4, 0, 4, 0],
      turn: "0",
      lastMove: null,
    };
    const next = applyMove(s, { pit: 0 });
    // Seed lands in pit 1, becomes 1 — but pit 11 is empty, so no capture.
    expect(next.pits[1]).toBe(1);
    expect(next.pits[STORE_0]).toBe(0);
  });
});

describe("mancala — endgame", () => {
  it("sweep when P0's side empties", () => {
    // P0 has just one seed left in pit 5. Plays it → lands in store 6.
    // After move P0 side is empty. Sweep P1's remaining seeds into P1's store.
    const s: MancalaState = {
      pits: [0, 0, 0, 0, 0, 1, 22, 3, 2, 0, 0, 0, 0, 20],
      turn: "0",
      lastMove: null,
    };
    const next = applyMove(s, { pit: 5 });
    expect(next.pits[STORE_0]).toBe(23);
    // Sweep moves 3 + 2 from P1 pits into P1's store.
    expect(next.pits[STORE_1]).toBe(25);
    for (let i = 0; i < 13; i++) if (i !== STORE_0) expect(next.pits[i]).toBe(0);
    const r = checkResult(next);
    expect(r.status).toBe("win");
    if (r.status === "win") expect(r.winner).toBe("1");
  });

  it("draw at 24-24", () => {
    const s: MancalaState = {
      pits: [0, 0, 0, 0, 0, 0, 24, 0, 0, 0, 0, 0, 0, 24],
      turn: "0",
      lastMove: null,
    };
    expect(checkResult(s).status).toBe("draw");
  });
});

describe("mancala — boardgame.io integration", () => {
  it("setup matches starting state", () => {
    const initial = (game.setup as () => MancalaState)();
    expect(initial.turn).toBe("0");
    expect(initial.pits[STORE_0]).toBe(0);
  });

  it("isLegalMove rejects opponent pits and empty pits", () => {
    const s = startingState();
    expect(isLegalMove(s, 6)).toBe(false); // store
    expect(isLegalMove(s, 7)).toBe(false); // opponent
    expect(isLegalMove(s, 0)).toBe(true);
    // Empty own pit.
    const s2 = { ...s, pits: [0, 4, 4, 4, 4, 4, 0, 4, 4, 4, 4, 4, 4, 0] };
    expect(isLegalMove(s2, 0)).toBe(false);
  });
});
