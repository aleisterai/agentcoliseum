import { describe, expect, it } from "vitest";
import { applyMove, checkResult, legalMoves, nimSum, opposite, startingState, type NimState } from "./game";
import { easyBot, hardBot, mediumBot } from "./bots";

describe("nim bots — legal moves only", () => {
  it("easyBot picks legal at start", () => {
    const s = startingState();
    const m = easyBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.pile === m.pile && x.take === m.take)).toBe(true);
  });
  it("mediumBot picks legal at start", () => {
    const s = startingState();
    const m = mediumBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.pile === m.pile && x.take === m.take)).toBe(true);
  });
  it("hardBot picks legal at start", () => {
    const s = startingState();
    const m = hardBot.pickMove(s, "0");
    expect(legalMoves(s).some((x) => x.pile === m.pile && x.take === m.take)).toBe(true);
  });
});

describe("nim hardBot — optimal play", () => {
  it("from a winning position brings nim-sum to 0", () => {
    // 3-4-5 has nim-sum 2. hardBot should produce a move whose resulting
    // state has nim-sum 0.
    const s = startingState();
    const m = hardBot.pickMove(s, "0");
    const next = applyMove(s, m);
    expect(nimSum(next.piles)).toBe(0);
  });

  it("from a P-position (nim-sum 0) hardBot still picks a legal move", () => {
    const s: NimState = { piles: [1, 2, 3], turn: "0", lastMove: null };
    expect(nimSum(s.piles)).toBe(0);
    const m = hardBot.pickMove(s, "0");
    // Result has nim-sum 0 still? No — we can't escape, but we should
    // take exactly 1 stone (delay tactic).
    expect(m.take).toBe(1);
  });

  it("hard vs hard from a winning position: P0 wins every time", () => {
    // From 3-4-5 (nim-sum 2), P0 has a forced win with perfect play.
    let s = startingState();
    let toMove: "0" | "1" = "0";
    while (true) {
      const r = checkResult(s);
      if (r.status === "win") {
        expect(r.winner).toBe("0");
        break;
      }
      const m = hardBot.pickMove(s, toMove);
      s = applyMove(s, m);
      // applyMove flips turn unless the position just terminated.
      toMove = s.turn;
    }
  });

  it("hard vs medium from a winning position: P0 (hard) wins", () => {
    let s = startingState();
    let toMove: "0" | "1" = "0";
    while (true) {
      const r = checkResult(s);
      if (r.status === "win") {
        // Either hard wins (correct) or medium wins (would be a bug).
        expect(r.winner).toBe("0");
        break;
      }
      const m = toMove === "0" ? hardBot.pickMove(s, "0") : mediumBot.pickMove(s, "1");
      s = applyMove(s, m);
      toMove = s.turn;
    }
  });

  // Suppress unused-import warning. We keep `opposite` import because it's
  // useful when debugging tests; harmless either way.
  void opposite;
});
