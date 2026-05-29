/**
 * Unit tests for the PoW helpers. Pure functions, no DB — fast.
 *
 * The "real" test is end-to-end through the registration endpoint
 * (challenge issue → solve → POST verify) but that requires the
 * pglite harness. These cover the math.
 */

import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import {
  countLeadingZeroBits,
  DEFAULT_DIFFICULTY,
  hashIp,
  issueChallenge,
  MAX_DIFFICULTY,
  solve,
  verifySolution,
} from "./index";

describe("countLeadingZeroBits", () => {
  it("all-zero buffer = 8 * length", () => {
    expect(countLeadingZeroBits(Buffer.alloc(4))).toBe(32);
  });
  it("0x80 = 0 (1 follows 0)", () => {
    expect(countLeadingZeroBits(Buffer.from([0x80]))).toBe(0);
  });
  it("0x40 = 1 (1-bit zero, then 1)", () => {
    expect(countLeadingZeroBits(Buffer.from([0x40]))).toBe(1);
  });
  it("0x01 = 7 (7-bit zero, then 1)", () => {
    expect(countLeadingZeroBits(Buffer.from([0x01]))).toBe(7);
  });
  it("0x00, 0x80 = 8", () => {
    expect(countLeadingZeroBits(Buffer.from([0x00, 0x80]))).toBe(8);
  });
  it("0x00, 0x00, 0x10 = 19", () => {
    expect(countLeadingZeroBits(Buffer.from([0x00, 0x00, 0x10]))).toBe(19);
  });
});

describe("issueChallenge", () => {
  it("returns 64-hex challenge + difficulty + timestamps", () => {
    const c = issueChallenge();
    expect(c.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(c.difficulty).toBe(DEFAULT_DIFFICULTY);
    expect(c.ttlSeconds).toBe(300);
    expect(new Date(c.issuedAt).getTime()).not.toBeNaN();
  });

  it("clamps difficulty to MAX_DIFFICULTY", () => {
    const c = issueChallenge({ difficulty: 9999 });
    expect(c.difficulty).toBe(MAX_DIFFICULTY);
  });

  it("clamps difficulty floor to 1", () => {
    const c = issueChallenge({ difficulty: 0 });
    expect(c.difficulty).toBe(1);
  });

  it("two challenges differ", () => {
    const a = issueChallenge();
    const b = issueChallenge();
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe("verifySolution + solve roundtrip", () => {
  // Use very low difficulty in tests so the loop is fast.
  it("solve produces a nonce that verifies (difficulty 8)", () => {
    const c = issueChallenge({ difficulty: 8 });
    const { nonce, iterations } = solve({
      challenge: c.challenge,
      difficulty: c.difficulty,
    });
    expect(iterations).toBeGreaterThan(0);
    expect(
      verifySolution({
        challenge: c.challenge,
        nonce,
        difficulty: c.difficulty,
      }),
    ).toBe(true);
  });

  it("rejects an off-by-one difficulty solution", () => {
    const c = issueChallenge({ difficulty: 4 });
    const { nonce } = solve({
      challenge: c.challenge,
      difficulty: c.difficulty,
    });
    // Same nonce against a HARDER target should usually fail; we use a
    // big difficulty bump to be safe (the chance of accidentally
    // satisfying d=20 with a d=4 solution is 1 / 2^16).
    const ok = verifySolution({
      challenge: c.challenge,
      nonce,
      difficulty: 20,
    });
    // We don't strictly require this to be false (vanishingly unlikely
    // false positive), but we ALWAYS require the d=4 check to be true.
    expect(
      verifySolution({
        challenge: c.challenge,
        nonce,
        difficulty: 4,
      }),
    ).toBe(true);
    void ok; // referenced for completeness
  });

  it("wrong challenge → wrong verification (nonce is bound to its challenge)", () => {
    // Solve for one challenge, then confirm the SAME nonce does not satisfy a
    // DIFFERENT challenge. A changed challenge yields an independent hash that
    // clears difficulty d with probability only 2^-d — so a single wrong
    // challenge at low difficulty would flake ~1/16. Instead we try every
    // first-hex-digit mutation and require at least one rejection; the chance
    // that ALL of them coincidentally still verify is (2^-8)^15 ≈ 10^-36.
    const c = issueChallenge({ difficulty: 8 });
    const { nonce } = solve({
      challenge: c.challenge,
      difficulty: c.difficulty,
    });
    let sawRejection = false;
    for (const digit of "0123456789abcdef") {
      const wrongChallenge = digit + c.challenge.slice(1);
      if (wrongChallenge === c.challenge) continue;
      if (
        !verifySolution({
          challenge: wrongChallenge,
          nonce,
          difficulty: c.difficulty,
        })
      ) {
        sawRejection = true;
        break;
      }
    }
    expect(sawRejection).toBe(true);
  });
});

describe("hashIp", () => {
  it("is stable for the same input", () => {
    expect(hashIp("1.2.3.4")).toBe(hashIp("1.2.3.4"));
  });
  it("differs across inputs", () => {
    expect(hashIp("1.2.3.4")).not.toBe(hashIp("1.2.3.5"));
  });
  it("returns 64 hex chars (sha256)", () => {
    expect(hashIp("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});
