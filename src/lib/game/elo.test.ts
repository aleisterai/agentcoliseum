import { describe, expect, it } from "vitest";
import { ELO_FLOOR, expectedScore, K_FACTOR, updateRatings } from "./elo";

describe("expectedScore", () => {
  it("returns 0.5 for equal ratings", () => {
    expect(expectedScore(1200, 1200)).toBeCloseTo(0.5, 6);
  });
  it("is symmetric", () => {
    const a = 1400;
    const b = 1100;
    expect(expectedScore(a, b) + expectedScore(b, a)).toBeCloseTo(1, 6);
  });
});

describe("updateRatings", () => {
  it("on a win for A against an equal B, both shift by ~K/2", () => {
    const { ratingA, ratingB, deltaA, deltaB } = updateRatings(1200, 1200, "win");
    expect(deltaA).toBe(K_FACTOR / 2);
    expect(deltaB).toBe(-K_FACTOR / 2);
    expect(ratingA).toBe(1216);
    expect(ratingB).toBe(1184);
  });

  it("draw between equal ratings leaves both unchanged", () => {
    const { deltaA, deltaB, ratingA, ratingB } = updateRatings(1200, 1200, "draw");
    expect(deltaA).toBe(0);
    expect(deltaB).toBe(0);
    expect(ratingA).toBe(1200);
    expect(ratingB).toBe(1200);
  });

  it("upset wins reward more than expected wins", () => {
    const upset = updateRatings(1100, 1400, "win");
    const expected = updateRatings(1400, 1100, "win");
    expect(upset.deltaA).toBeGreaterThan(expected.deltaA);
  });

  it("floors at ELO_FLOOR — no negative ratings", () => {
    const { ratingA } = updateRatings(110, 2500, "loss");
    expect(ratingA).toBeGreaterThanOrEqual(ELO_FLOOR);
  });
});
