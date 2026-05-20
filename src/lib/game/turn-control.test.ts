/**
 * Tests for the shared extra-turn wrapper used by mancala, dots-and-
 * boxes, and reversi.
 *
 * Approach: simulate boardgame.io's move-ctx shape and exercise the
 * three behaviors we care about — pass-through, kept-turn, and entry
 * rejection.
 */
import { describe, expect, it, vi } from "vitest";
import { INVALID_MOVE } from "boardgame.io/core";
import { extraTurnAware } from "./turn-control";

interface DummyG {
  turn: string;
  moves: number;
}

function makeCtx(initialTurn: string, playerID: string) {
  const G: DummyG = { turn: initialTurn, moves: 0 };
  const events = { endTurn: vi.fn() };
  return { G, playerID, events };
}

describe("extraTurnAware", () => {
  it("calls events.endTurn when the move flips G.turn to the opponent", () => {
    const move = extraTurnAware<DummyG, void>((G, _pid) => {
      G.moves += 1;
      G.turn = "1"; // flipped
    });
    const ctx = makeCtx("0", "0");
    const result = move(ctx, undefined);
    expect(result).toBeUndefined();
    expect(ctx.G.turn).toBe("1");
    expect(ctx.events.endTurn).toHaveBeenCalledTimes(1);
  });

  it("does NOT call events.endTurn when the extra-turn rule kept G.turn", () => {
    const move = extraTurnAware<DummyG, void>((G, _pid) => {
      G.moves += 1;
      // Bonus turn — G.turn stays.
    });
    const ctx = makeCtx("0", "0");
    move(ctx, undefined);
    expect(ctx.G.turn).toBe("0");
    expect(ctx.events.endTurn).not.toHaveBeenCalled();
  });

  it("returns INVALID_MOVE if the inner returned INVALID_MOVE", () => {
    const move = extraTurnAware<DummyG, void>(() => INVALID_MOVE);
    const ctx = makeCtx("0", "0");
    const result = move(ctx, undefined);
    expect(result).toBe(INVALID_MOVE);
    expect(ctx.events.endTurn).not.toHaveBeenCalled();
  });

  it("returns INVALID_MOVE when the playerID isn't the current G-turn-holder", () => {
    const move = extraTurnAware<DummyG, void>(() => {
      throw new Error("inner should not run");
    });
    const ctx = makeCtx("1", "0"); // it's P1's G-turn but P0 called
    expect(move(ctx, undefined)).toBe(INVALID_MOVE);
  });

  it("returns INVALID_MOVE when playerID is undefined (spectator)", () => {
    const move = extraTurnAware<DummyG, void>(() => {
      throw new Error("inner should not run");
    });
    const G: DummyG = { turn: "0", moves: 0 };
    const ctx = { G, playerID: undefined, events: { endTurn: vi.fn() } };
    expect(move(ctx, undefined)).toBe(INVALID_MOVE);
  });

  it("honors a custom isCurrentPlayer (reversi's playerID→side mapping)", () => {
    // Reversi: playerID "0" = "B", "1" = "W"
    const move = extraTurnAware<{ turn: "B" | "W"; moves: number }, void>(
      (G, _pid) => {
        G.moves += 1;
        G.turn = G.turn === "B" ? "W" : "B"; // flip side
      },
      {
        isCurrentPlayer: (G, pid) =>
          G.turn === (pid === "0" ? "B" : "W"),
      },
    );
    const G = { turn: "B" as const, moves: 0 };
    const events = { endTurn: vi.fn() };
    const ctx = { G, playerID: "0", events };
    const result = move(ctx, undefined);
    expect(result).toBeUndefined();
    // After: G.turn flipped to "W" — playerID "0" no longer corresponds
    // to current side → endTurn called.
    expect(ctx.G.turn).toBe("W");
    expect(events.endTurn).toHaveBeenCalledTimes(1);
  });
});
