import { describe, expect, it } from "vitest";
import { buildEngine } from "@/lib/game/engine";
import {
  CHECKERS,
  applyTurn,
  checkResult,
  game,
  legalTurns,
  pipCount,
  singleMoves,
  startingState,
  type BackgammonMove,
  type BackgammonState,
  type PlayerId,
  type SubMove,
} from "./game";
import { backgammonAdapter } from "./index";
import { hardBot, mediumBot } from "./bots";

function mk(opts: {
  points?: Record<number, number>;
  bar?: Partial<{ "0": number; "1": number }>;
  off?: Partial<{ "0": number; "1": number }>;
  turn?: PlayerId;
  dice: number[];
}): BackgammonState {
  const points = new Array<number>(24).fill(0);
  for (const [k, v] of Object.entries(opts.points ?? {})) points[Number(k)] = v;
  return {
    points,
    bar: { "0": 0, "1": 0, ...opts.bar },
    off: { "0": 0, "1": 0, ...opts.off },
    turn: opts.turn ?? "0",
    dice: opts.dice.slice(),
    rolled: [opts.dice[0], opts.dice[1] ?? opts.dice[0]],
    rollPending: false,
    lastMove: null,
  };
}

/** WS-ish view from a working result for assertions. */
function ptsAfter(s: BackgammonState, moves: SubMove[]): {
  points: number[];
  bar: { "0": number; "1": number };
  off: { "0": number; "1": number };
} {
  const r = applyTurn(s, s.turn, moves);
  if (!r.ok || !r.next) throw new Error(`expected legal: ${r.error}`);
  return { points: r.next.pts, bar: r.next.bar, off: r.next.off };
}

describe("backgammon — setup", () => {
  it("opens with 15 checkers each and the standard 167 pip count", () => {
    const s = startingState();
    const p0 = s.points.filter((n) => n > 0).reduce((a, n) => a + n, 0);
    const p1 = -s.points.filter((n) => n < 0).reduce((a, n) => a + n, 0);
    expect(p0).toBe(CHECKERS);
    expect(p1).toBe(CHECKERS);
    const ws = { pts: s.points, bar: s.bar, off: s.off };
    expect(pipCount(ws, "0")).toBe(167);
    expect(pipCount(ws, "1")).toBe(167);
  });
});

describe("backgammon — blocking + hitting", () => {
  it("can't land on a point with 2+ enemy checkers", () => {
    const s = mk({ points: { 10: 1, 7: -2 }, dice: [3, 6] }); // p0 on 10, p1 wall on 7
    const m3 = singleMoves({ pts: s.points, bar: s.bar, off: s.off }, "0", 3);
    expect(m3.some((m) => m.from === 10 && m.to === 7)).toBe(false); // 10-3=7 blocked
  });
  it("landing on a lone enemy checker hits it to the bar", () => {
    const s = mk({ points: { 10: 1, 7: -1 }, dice: [3, 5] }); // p1 blot on 7
    const after = ptsAfter(s, [{ from: 10, to: 7 }, { from: 7, to: 2 }]);
    // After the full legal 2-die turn the hit happened: p1 has one on the bar.
    expect(after.bar["1"]).toBe(1);
  });
});

describe("backgammon — bar re-entry", () => {
  it("must re-enter from the bar before any other move", () => {
    const s = mk({ points: { 10: 1 }, bar: { "0": 1 }, dice: [2, 4] });
    const ws = { pts: s.points, bar: s.bar, off: s.off };
    // With a checker on the bar, the only single-moves are bar entries.
    expect(singleMoves(ws, "0", 2).every((m) => m.from === "bar")).toBe(true);
    expect(singleMoves(ws, "0", 4).every((m) => m.from === "bar")).toBe(true);
    // die 2 → 24-2 = 22, die 4 → 20.
    expect(singleMoves(ws, "0", 2)[0]).toEqual({ from: "bar", to: 22 });
  });
  it("forced pass when every entry point is blocked", () => {
    // p0 on bar; p1 walls all of p0's entry board (18..23).
    const s = mk({
      points: { 18: -2, 19: -2, 20: -2, 21: -2, 22: -2, 23: -2 },
      bar: { "0": 1 },
      dice: [1, 5],
    });
    expect(legalTurns(s, "0")).toHaveLength(0);
    expect(applyTurn(s, "0", []).ok).toBe(true); // pass allowed
    expect(applyTurn(s, "0", [{ from: "bar", to: 23 }]).ok).toBe(false);
  });
});

describe("backgammon — bear off", () => {
  it("a higher die bears off the highest checker when none is higher", () => {
    const s = mk({ points: { 2: 1 }, off: { "0": 14 }, dice: [6, 1] }); // all home
    const ws = { pts: s.points, bar: s.bar, off: s.off };
    expect(singleMoves(ws, "0", 6).some((m) => m.from === 2 && m.to === "off")).toBe(true);
  });
  it("bearing off the last checker wins", () => {
    const s = mk({ points: { 5: 1, 3: 1 }, off: { "0": 13 }, dice: [6, 4] });
    const after = ptsAfter(s, [{ from: 5, to: "off" }, { from: 3, to: "off" }]);
    expect(after.off["0"]).toBe(CHECKERS);
    expect(
      checkResult({ ...s, points: after.points, off: after.off }).status,
    ).toBe("win");
  });
});

describe("backgammon — maximal dice usage", () => {
  it("requires playing both dice when a 2-die sequence exists", () => {
    // p0 single checker on idx 8, dice [5,3]. Every legal full turn lands on
    // idx 0 (8→3→0 or 8→5→0). A 1-die play (8→3) is a non-maximal end → rejected.
    const s = mk({ points: { 8: 1 }, off: { "0": 14 }, dice: [5, 3] });
    const turns = legalTurns(s, "0");
    expect(turns.every((t) => t.seq.length === 2)).toBe(true);
    expect(applyTurn(s, "0", [{ from: 8, to: 3 }]).ok).toBe(false); // under-use
    expect(applyTurn(s, "0", [{ from: 8, to: 3 }, { from: 3, to: 0 }]).ok).toBe(true);
  });
});

describe("backgammon — engine self-play (e2e, seeded dice)", () => {
  it("plays a full hard-vs-medium game to a bear-off win", () => {
    const engine = buildEngine(game);
    let state = engine.initialState();
    // onBegin rolled the opening dice.
    expect((state.G as BackgammonState).dice.length).toBeGreaterThanOrEqual(2);
    let over = engine.gameOver(state);
    let plies = 0;
    while (!over && plies < 4000) {
      const G = state.G as BackgammonState;
      const mover: PlayerId = G.turn;
      const bot = mover === "0" ? hardBot : mediumBot;
      const move = bot.pickMove(G, mover) as BackgammonMove;
      const next = engine.applyMove(state, mover, "play", [{ moves: move.moves }]);
      expect(next, `engine rejected bot turn at ply ${plies}: ${JSON.stringify(move.moves)}`).not.toBeNull();
      state = next!;
      over = engine.gameOver(state);
      plies += 1;
    }
    expect(over).not.toBeNull();
    const g = state.G as BackgammonState;
    expect(g.off["0"] === CHECKERS || g.off["1"] === CHECKERS).toBe(true);
  });
});

describe("backgammon — adapter", () => {
  it("validateMovePayload accepts hops + pass, rejects junk", () => {
    expect(backgammonAdapter.validateMovePayload({ moves: [{ from: 12, to: 7 }] }).ok).toBe(true);
    expect(backgammonAdapter.validateMovePayload({ moves: [{ from: "bar", to: 23 }] }).ok).toBe(true);
    expect(backgammonAdapter.validateMovePayload({ moves: [] }).ok).toBe(true);
    expect(backgammonAdapter.validateMovePayload({ moves: [{ from: 99, to: 7 }] }).ok).toBe(false);
    expect(backgammonAdapter.validateMovePayload({ moves: [{ from: 1, to: "nope" }] }).ok).toBe(false);
    expect(backgammonAdapter.validateMovePayload({ nope: 1 }).ok).toBe(false);
  });
  it("clock + perfect-info wiring", () => {
    expect(backgammonAdapter.clockBudgetMs).toBe(240 * 1000);
    expect(backgammonAdapter.perfectInformation).toBe(true);
    expect(backgammonAdapter.id).toBe("backgammon");
  });
});
