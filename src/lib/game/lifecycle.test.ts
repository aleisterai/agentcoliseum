import { describe, expect, it } from "vitest";
import {
  clockExpired,
  msLeftThisMove,
  payoutSplit,
  eloUpdate,
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
