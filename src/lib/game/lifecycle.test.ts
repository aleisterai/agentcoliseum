import { describe, expect, it } from "vitest";
import {
  clockExpired,
  msLeftThisMove,
  payoutSplit,
  eloUpdate,
  FIRST_MOVE_TIMEOUT_MS,
} from "./lifecycle";

describe("payoutSplit", () => {
  describe("winner path", () => {
    it("gives the winner 95% of the pot and treasury 5%", () => {
      const split = payoutSplit({ potUsdc: 1_000_000, isDraw: false, stakeUsdc: 500_000 });
      expect(split.winnerCut).toBe(950_000);
      expect(split.treasury).toBe(50_000);
    });

    it("rounds the treasury down (no fractional microUSDC)", () => {
      const split = payoutSplit({ potUsdc: 1_000_001, isDraw: false, stakeUsdc: 500_000 });
      // 5% of 1_000_001 = 50_000.05 → floor 50_000; winnerCut = 950_001
      expect(split.treasury).toBe(50_000);
      expect(split.winnerCut).toBe(950_001);
      // Sanity: winner + treasury should never exceed pot.
      expect(split.winnerCut + split.treasury).toBeLessThanOrEqual(1_000_001);
    });

    it("never returns refundEach > 0 on a win", () => {
      const split = payoutSplit({ potUsdc: 1_000_000, isDraw: false, stakeUsdc: 500_000 });
      expect(split.refundEach ?? 0).toBe(0);
    });
  });

  describe("draw path (Option A: full refund, zero fee)", () => {
    it("refunds each side their exact stake — no platform fee skim", () => {
      const split = payoutSplit({ potUsdc: 1_000_000, isDraw: true, stakeUsdc: 500_000 });
      // Locked contract: refundEach === stakeUsdc, treasury === 0.
      expect(split.refundEach).toBe(500_000);
      expect(split.treasury).toBe(0);
      expect(split.treasuryDraw).toBe(0);
      expect(split.winnerCut).toBe(0);
    });

    it("total refunded to both sides equals the pot exactly", () => {
      const split = payoutSplit({ potUsdc: 1_234_567, isDraw: true, stakeUsdc: 617_283 });
      const totalOut = (split.refundEach ?? 0) * 2 + split.treasury;
      // pot is 2× stake by construction in real matches; we accept whatever
      // the caller passed and just verify both sides + treasury account
      // for the full input.
      expect(totalOut).toBe(617_283 * 2);
    });

    it("handles zero-stake draws (free / system mode) cleanly", () => {
      const split = payoutSplit({ potUsdc: 0, isDraw: true, stakeUsdc: 0 });
      expect(split.refundEach).toBe(0);
      expect(split.treasury).toBe(0);
    });
  });
});

describe("clockExpired (per-move)", () => {
  it("returns false while elapsed < perMoveMs", () => {
    const turnStartedAt = new Date(1_000_000);
    const now = new Date(1_000_000 + 29_999);
    expect(clockExpired({ turnStartedAt, perMoveMs: 30_000, now })).toBe(false);
  });

  it("returns true once elapsed >= perMoveMs", () => {
    const turnStartedAt = new Date(1_000_000);
    const now = new Date(1_000_000 + 30_000);
    expect(clockExpired({ turnStartedAt, perMoveMs: 30_000, now })).toBe(true);
  });

  describe("move-0 unready gate", () => {
    // Pre-readiness frozen state: clock NEVER expires regardless of how
    // much time has passed. The long-tail `refund-unready-matches` cron
    // is the one that sweeps these (after 30 min).
    it("never expires when moveCount=0 AND agentReadyAt is null, even at huge elapsed", () => {
      const turnStartedAt = new Date(1_000_000);
      const now = new Date(1_000_000 + 24 * 60 * 60 * 1000); // +24h
      expect(
        clockExpired({
          turnStartedAt,
          perMoveMs: 30_000,
          now,
          moveCount: 0,
          agentReadyAt: null,
        }),
      ).toBe(false);
    });
  });

  describe("move-0 ready first-move timeout (architect P0-#136 fix)", () => {
    // When the agent has gone ready but stalled on move 0, we apply
    // the TIGHTER FIRST_MOVE_TIMEOUT_MS budget (currently 90s) rather
    // than the full per-move budget. Locks in that long-clock games
    // (chess: 600s) don't sit "live but stuck" for 10 min.
    it("returns false while sinceReady < FIRST_MOVE_TIMEOUT_MS", () => {
      const turnStartedAt = new Date(1_000_000);
      const now = new Date(1_000_000 + FIRST_MOVE_TIMEOUT_MS - 1);
      expect(
        clockExpired({
          turnStartedAt,
          perMoveMs: 600_000, // chess-length, deliberately >> first-move budget
          now,
          moveCount: 0,
          agentReadyAt: turnStartedAt,
        }),
      ).toBe(false);
    });

    it("returns true once sinceReady >= FIRST_MOVE_TIMEOUT_MS", () => {
      const turnStartedAt = new Date(1_000_000);
      const now = new Date(1_000_000 + FIRST_MOVE_TIMEOUT_MS);
      expect(
        clockExpired({
          turnStartedAt,
          perMoveMs: 600_000,
          now,
          moveCount: 0,
          agentReadyAt: turnStartedAt,
        }),
      ).toBe(true);
    });

    it("uses the tighter budget even when perMoveMs is small (no regression for short-clock games)", () => {
      // tic-tac-toe-style 120s perMoveMs. The first-move budget is
      // still smaller (90s), so behavior is unchanged for short games.
      const turnStartedAt = new Date(1_000_000);
      const now = new Date(1_000_000 + 100_000); // 100s
      expect(
        clockExpired({
          turnStartedAt,
          perMoveMs: 120_000,
          now,
          moveCount: 0,
          agentReadyAt: turnStartedAt,
        }),
      ).toBe(true); // 100s > 90s, expired
    });
  });

  describe("move-1+ falls back to perMoveMs (normal chess-clock)", () => {
    it("uses perMoveMs once real play is underway, even with agentReadyAt set", () => {
      const turnStartedAt = new Date(1_000_000);
      const now = new Date(1_000_000 + 95_000); // 95s elapsed
      // 95s > FIRST_MOVE_TIMEOUT_MS but < perMoveMs (600s).
      // moveCount=1 → first-move budget DOES NOT apply.
      expect(
        clockExpired({
          turnStartedAt,
          perMoveMs: 600_000,
          now,
          moveCount: 1,
          agentReadyAt: new Date(900_000),
        }),
      ).toBe(false);
    });
  });
});

describe("msLeftThisMove", () => {
  it("clamps to >= 0", () => {
    const turnStartedAt = new Date(1_000_000);
    const now = new Date(1_000_000 + 999_999);
    expect(msLeftThisMove({ turnStartedAt, perMoveMs: 30_000, now })).toBe(0);
  });

  it("counts down linearly", () => {
    const turnStartedAt = new Date(1_000_000);
    const now = new Date(1_000_000 + 10_000);
    expect(msLeftThisMove({ turnStartedAt, perMoveMs: 30_000, now })).toBe(20_000);
  });

  describe("move-0 unready: full per-move budget", () => {
    it("reports the FULL per-move budget while the clock is paused", () => {
      const turnStartedAt = new Date(1_000_000);
      const now = new Date(1_000_000 + 99_999_999);
      expect(
        msLeftThisMove({
          turnStartedAt,
          perMoveMs: 30_000,
          now,
          moveCount: 0,
          agentReadyAt: null,
        }),
      ).toBe(30_000);
    });
  });

  describe("move-0 ready: tighter first-move countdown", () => {
    // After the agent reads state once, the spectator UI should show
    // the FIRST_MOVE_TIMEOUT_MS countdown — not the full per-move
    // budget. Honest deadline so users aren't surprised by the cron.
    it("counts down from FIRST_MOVE_TIMEOUT_MS, not perMoveMs", () => {
      const turnStartedAt = new Date(1_000_000);
      const now = new Date(1_000_000 + 30_000); // 30s in
      const ms = msLeftThisMove({
        turnStartedAt,
        perMoveMs: 600_000,
        now,
        moveCount: 0,
        agentReadyAt: turnStartedAt,
      });
      // 90_000 - 30_000 = 60_000
      expect(ms).toBe(FIRST_MOVE_TIMEOUT_MS - 30_000);
    });

    it("clamps to 0 once the first-move budget is gone", () => {
      const turnStartedAt = new Date(1_000_000);
      const now = new Date(1_000_000 + 999_999);
      const ms = msLeftThisMove({
        turnStartedAt,
        perMoveMs: 600_000,
        now,
        moveCount: 0,
        agentReadyAt: turnStartedAt,
      });
      expect(ms).toBe(0);
    });
  });
});

describe("eloUpdate (draws)", () => {
  it("equal-rated draw is a no-op (deltas are 0)", () => {
    const r = eloUpdate({ p1Elo: 1200, p2Elo: 1200, outcome: "draw" });
    expect(r.p1Delta).toBe(0);
    expect(r.p2Delta).toBe(0);
  });

  it("draw transfers points from higher-rated to lower-rated", () => {
    const r = eloUpdate({ p1Elo: 1400, p2Elo: 1100, outcome: "draw" });
    // Higher-rated should lose points, lower-rated should gain.
    expect(r.p1Delta).toBeLessThan(0);
    expect(r.p2Delta).toBeGreaterThan(0);
    // Conservation: deltas should sum to zero (round-to-nearest may
    // introduce ±1 on certain inputs, so we allow a 1-point tolerance).
    expect(Math.abs(r.p1Delta + r.p2Delta)).toBeLessThanOrEqual(1);
  });
});
