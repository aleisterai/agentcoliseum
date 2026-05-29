import { describe, expect, it } from "vitest";
import { buildEngine } from "@/lib/game/engine";
import {
  MAX_MOVES,
  N,
  PIECES_EACH,
  applyTurn,
  captureCells,
  checkResult,
  game,
  hasAnyCapture,
  isStrong,
  legalTurns,
  pieceCount,
  startingState,
  stepDir,
  type Cell,
  type FanoronaMove,
  type FanoronaState,
  type PlayerId,
} from "./game";
import { fanoronaAdapter } from "./index";
import { hardBot } from "./bots";

function mk(cells: Record<number, Cell>, turn: PlayerId = "0", moveCount = 0): FanoronaState {
  const board = Array<Cell>(N).fill("");
  for (const [k, v] of Object.entries(cells)) board[Number(k)] = v;
  return { board, turn, lastMove: null, moveCount };
}

describe("fanorona — setup + geometry", () => {
  it("opens with 22 pieces each and an empty centre", () => {
    const s = startingState();
    expect(pieceCount(s, "0")).toBe(PIECES_EACH);
    expect(pieceCount(s, "1")).toBe(PIECES_EACH);
    expect(s.board[22]).toBe(""); // centre (row 2, col 4)
  });

  it("strong points are the even-(row+col) intersections; diagonals only there", () => {
    expect(isStrong(0)).toBe(true); // corner (0,0)
    expect(isStrong(22)).toBe(true); // centre (2,4)
    expect(isStrong(1)).toBe(false); // (0,1) weak
    // A diagonal step is legal from the strong centre…
    expect(stepDir(22, 12)).toBeGreaterThanOrEqual(0); // (2,4)→(1,3) NW
    // …but not from a weak point: (0,1)→(1,2) would be a diagonal off a weak node.
    expect(stepDir(1, 11)).toBe(-1);
    // Orthogonal steps are legal everywhere, weak nodes included.
    expect(stepDir(1, 10)).toBeGreaterThanOrEqual(0); // (0,1)→(1,1) S
  });
});

describe("fanorona — capture mechanics", () => {
  it("the classic opening approach captures the enemy file", () => {
    const start = startingState();
    // (3,4)=31 → (2,4)=22 (centre), approaching N over (1,4)=13 and (0,4)=4.
    const res = applyTurn(start, "0", { from: 31, steps: [{ to: 22, capture: "approach" }] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.next.board[22]).toBe("0");
    expect(res.next.board[31]).toBe("");
    expect(res.next.board[13]).toBe(""); // captured
    expect(res.next.board[4]).toBe(""); // captured
    expect(res.next.lastMove?.captured).toBe(2);
    expect(pieceCount(res.next, "1")).toBe(PIECES_EACH - 2);
  });

  it("a withdrawal captures the line behind the start point", () => {
    // "0" at centre 22; enemy line behind it to the west (21, 20). Move east.
    const s = mk({ 22: "0", 21: "1", 20: "1", 0: "1" });
    const { withdraw } = captureCells(s.board, "0", 22, /* E */ 3);
    expect(withdraw).toEqual([21, 20]);
    const res = applyTurn(s, "0", { from: 22, steps: [{ to: 23, capture: "withdraw" }] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.next.board[23]).toBe("0");
    expect(res.next.board[21]).toBe("");
    expect(res.next.board[20]).toBe("");
    expect(res.next.lastMove?.captured).toBe(2);
  });

  it("captures via a 2-hop chain that changes direction", () => {
    // (4,2)=38 →NE (3,3)=30 approach over (2,4)=22; then →NW (2,2)=20 approach
    // over (1,1)=10. Both landings empty; directions differ (NE then NW).
    const s = mk({ 38: "0", 22: "1", 10: "1", 44: "1" });
    const res = applyTurn(s, "0", {
      from: 38,
      steps: [
        { to: 30, capture: "approach" },
        { to: 20, capture: "approach" },
      ],
    });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.next.board[20]).toBe("0"); // final landing
    expect(res.next.board[38]).toBe(""); // vacated start
    expect(res.next.board[30]).toBe(""); // passed through
    expect(res.next.board[22]).toBe(""); // captured on hop 1
    expect(res.next.board[10]).toBe(""); // captured on hop 2
    expect(res.next.lastMove?.captured).toBe(2);
  });
});

describe("fanorona — chain constraints", () => {
  it("rejects two consecutive hops in the same direction (but allows stopping)", () => {
    // (4,4)=40 →N (3,4)=31 approach over (2,4)=22; a second N hop to (2,4)=22
    // WOULD capture (1,4)=13, but repeating the direction is illegal.
    const s = mk({ 40: "0", 22: "1", 13: "1", 44: "1" });
    const single: FanoronaMove = { from: 40, steps: [{ to: 31, capture: "approach" }] };
    expect(applyTurn(s, "0", single).ok).toBe(true); // stopping after one capture is fine
    const repeat: FanoronaMove = {
      from: 40,
      steps: [
        { to: 31, capture: "approach" },
        { to: 22, capture: "approach" },
      ],
    };
    expect(applyTurn(s, "0", repeat).ok).toBe(false);
  });

  it("never enumerates a turn that repeats a direction or revisits a point", () => {
    const s = mk({ 38: "0", 22: "1", 10: "1", 14: "1", 6: "1", 44: "1" });
    const dirOf = (a: number, b: number) => stepDir(a, b);
    for (const turn of legalTurns(s, "0")) {
      const visited = new Set<number>([turn.from]);
      let cur = turn.from;
      let lastDir = -1;
      for (const st of turn.steps) {
        const d = dirOf(cur, st.to);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(visited.has(st.to)).toBe(false);
        if (lastDir >= 0) expect(d).not.toBe(lastDir);
        visited.add(st.to);
        lastDir = d;
        cur = st.to;
      }
    }
  });
});

describe("fanorona — mandatory capture", () => {
  it("rejects a paika move while a capture is available", () => {
    const s = mk({ 22: "0", 21: "1", 20: "1", 0: "1" });
    expect(hasAnyCapture(s, "0")).toBe(true);
    // 22→31 (S) captures nothing → a paika, illegal because a capture exists.
    expect(applyTurn(s, "0", { from: 22, steps: [{ to: 31, capture: null }] }).ok).toBe(false);
    // Even declaring the empty south step as a "capture" fails (nothing there).
    expect(applyTurn(s, "0", { from: 22, steps: [{ to: 31, capture: "approach" }] }).ok).toBe(false);
  });

  it("allows a single paika only when no capture exists; rejects multi-step paika", () => {
    const s = mk({ 22: "0", 0: "1" }); // lone pieces, nothing adjacent to capture
    expect(hasAnyCapture(s, "0")).toBe(false);
    expect(applyTurn(s, "0", { from: 22, steps: [{ to: 23, capture: null }] }).ok).toBe(true);
    // A paika is a single hop — chaining null steps is illegal.
    expect(
      applyTurn(s, "0", {
        from: 22,
        steps: [
          { to: 23, capture: null },
          { to: 24, capture: null },
        ],
      }).ok,
    ).toBe(false);
  });
});

describe("fanorona — termination", () => {
  it("capturing the opponent's last pieces is a win", () => {
    const s = mk({ 22: "0", 21: "1", 20: "1" }); // only enemies are 21,20
    const res = applyTurn(s, "0", { from: 22, steps: [{ to: 23, capture: "withdraw" }] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(pieceCount(res.next, "1")).toBe(0);
    expect(checkResult(res.next)).toEqual({ status: "win", winner: "0" });
  });

  it("a player to move with no legal move loses", () => {
    // "1" to move owns only idx 0, hemmed by its own... actually surround it so
    // it has no empty neighbour and no capture. (0,0) neighbours: (0,1)=1,(1,0)=1,(1,1)=1.
    const s = mk({ 0: "1", 1: "0", 9: "0", 10: "0", 44: "0" }, "1");
    expect(legalTurns(s, "1")).toHaveLength(0);
    expect(checkResult(s)).toEqual({ status: "win", winner: "0" });
  });
});

describe("fanorona — adapter", () => {
  it("validateMovePayload accepts chains + paika, rejects junk", () => {
    expect(
      fanoronaAdapter.validateMovePayload({ from: 31, steps: [{ to: 22, capture: "approach" }] }).ok,
    ).toBe(true);
    expect(
      fanoronaAdapter.validateMovePayload({ from: 36, steps: [{ to: 27, capture: null }] }).ok,
    ).toBe(true);
    expect(fanoronaAdapter.validateMovePayload({ from: 0, steps: [] }).ok).toBe(false);
    expect(fanoronaAdapter.validateMovePayload({ from: 99, steps: [{ to: 0, capture: null }] }).ok).toBe(
      false,
    );
    expect(
      fanoronaAdapter.validateMovePayload({ from: 0, steps: [{ to: 1, capture: "sideways" }] }).ok,
    ).toBe(false);
    expect(fanoronaAdapter.validateMovePayload({ nope: 1 }).ok).toBe(false);
  });

  it("clock + perfect-info wiring", () => {
    expect(fanoronaAdapter.clockBudgetMs).toBe(240 * 1000);
    expect(fanoronaAdapter.perfectInformation).toBe(true);
    expect(fanoronaAdapter.id).toBe("fanorona");
  });
});

describe("fanorona — engine self-play (e2e, deterministic)", () => {
  it("plays a full hard-vs-hard game to a terminal result", () => {
    const engine = buildEngine(game);
    let state = engine.initialState();
    let over = engine.gameOver(state);
    let plies = 0;
    while (!over && plies < MAX_MOVES + 2) {
      const G = state.G as FanoronaState;
      const mover: PlayerId = G.turn;
      const move = hardBot.pickMove(G, mover) as FanoronaMove;
      const next = engine.applyMove(state, mover, "play", [move]);
      expect(
        next,
        `engine rejected bot turn at ply ${plies}: ${JSON.stringify(move)}`,
      ).not.toBeNull();
      state = next!;
      over = engine.gameOver(state);
      plies += 1;
    }
    expect(over).not.toBeNull();
    const g = state.G as FanoronaState;
    const result = checkResult(g);
    expect(result.status === "win" || result.status === "draw").toBe(true);
    // A win means the loser was wiped or stuck; a draw means the ply cap held.
    if (result.status === "draw") expect(g.moveCount).toBeGreaterThanOrEqual(MAX_MOVES);
  });
});
