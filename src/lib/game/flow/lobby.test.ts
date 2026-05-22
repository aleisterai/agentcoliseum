/**
 * Unit tests for the lobby-flow utilities that DON'T need a database
 * harness. Specifically: per-move clock preset validation.
 *
 * Integration tests for postChallenge / acceptChallenge (which do real
 * DB writes) require a test Postgres harness — tracked as a follow-up.
 * See README.md "Testing" section for the gap.
 */
import { describe, expect, it } from "vitest";
// Import from the pure-helpers file so the test doesn't pull in the
// DB client (which throws on missing DATABASE_URL at module load).
import {
  PER_MOVE_PRESETS,
  DEFAULT_PER_MOVE_SECONDS,
  isValidPerMoveSeconds,
} from "./per-move";

describe("PerMoveSeconds presets", () => {
  it("exposes the five recalibrated presets", () => {
    // Recalibrated 2026-05 from 15/30/45/60. LLM token generation
    // (not engine compute) dominates wall-clock; old presets were
    // too tight and produced ~66% time-forfeit rates in production.
    expect(PER_MOVE_PRESETS).toEqual([60, 120, 180, 300, 600]);
  });

  it("DEFAULT_PER_MOVE_SECONDS is one of the presets", () => {
    expect(PER_MOVE_PRESETS).toContain(DEFAULT_PER_MOVE_SECONDS);
  });

  it("DEFAULT is 120s — enough headroom for typical reasoning generation", () => {
    // Locked deliberately so a future "let's change the default" PR
    // surfaces in code review instead of silently widening every new
    // match's clock.
    expect(DEFAULT_PER_MOVE_SECONDS).toBe(120);
  });
});

describe("isValidPerMoveSeconds", () => {
  it("accepts every preset value", () => {
    for (const v of PER_MOVE_PRESETS) {
      expect(isValidPerMoveSeconds(v)).toBe(true);
    }
  });

  it("rejects out-of-set numeric values", () => {
    expect(isValidPerMoveSeconds(0)).toBe(false);
    expect(isValidPerMoveSeconds(1)).toBe(false);
    expect(isValidPerMoveSeconds(20)).toBe(false);
    // Old preset values now rejected — code review surface.
    expect(isValidPerMoveSeconds(15)).toBe(false);
    expect(isValidPerMoveSeconds(30)).toBe(false);
    expect(isValidPerMoveSeconds(45)).toBe(false);
    expect(isValidPerMoveSeconds(-30)).toBe(false);
    expect(isValidPerMoveSeconds(Number.NaN)).toBe(false);
    expect(isValidPerMoveSeconds(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("rejects non-numeric values", () => {
    expect(isValidPerMoveSeconds("30")).toBe(false);
    expect(isValidPerMoveSeconds(null)).toBe(false);
    expect(isValidPerMoveSeconds(undefined)).toBe(false);
    expect(isValidPerMoveSeconds({})).toBe(false);
    expect(isValidPerMoveSeconds([30])).toBe(false);
    expect(isValidPerMoveSeconds(true)).toBe(false);
  });

  it("narrows the type so the caller can use it as PerMoveSeconds", () => {
    const v: unknown = 180;
    if (isValidPerMoveSeconds(v)) {
      // If this compiles, the type guard is doing its job.
      const seconds: 60 | 120 | 180 | 300 | 600 = v;
      expect([60, 120, 180, 300, 600]).toContain(seconds);
    }
  });
});
