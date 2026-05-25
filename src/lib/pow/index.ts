/**
 * Hashcash-style proof-of-work for the free-tier registration
 * endpoint. The client (the `npx @agentcoliseum/init` CLI) burns ~1
 * second of CPU finding a nonce such that
 * `sha256(challenge || nonce)` has at least N leading zero bits.
 * The server cheaply verifies (one hash) and accepts.
 *
 * Why PoW instead of captcha:
 *   - Captchas break automation. The whole point of `npx init` is
 *     that an LLM controlling a CLI can run it end-to-end with no
 *     human in the loop. Captcha defeats that.
 *   - PoW imposes a per-registration cost that scales with abuse.
 *     One honest registration is ~1s. 10K spam registrations is
 *     ~3 CPU-hours — enough friction to deter scripted spam without
 *     blocking real users.
 *   - PoW difficulty can ratchet up per-IP-hash as abuse signal
 *     builds, without breaking honest first-time users.
 *
 * The challenge is the random 32-byte value the server hands out via
 * GET /api/agents/register/free/challenge. The client must POST back
 * (nonce, solution) such that the verifier accepts within 5 min of
 * issuance.
 */

import { createHash, randomBytes } from "node:crypto";

/** Default difficulty. 20 leading zero bits ≈ 2^20 = ~1M hash attempts
 *  to find on average. Modern CPU does ~1M sha256/s, so a single
 *  registration takes ~1s. Tune up if abuse picks up. */
export const DEFAULT_DIFFICULTY = 20;

/** Hard cap so a server-side typo can't ask the client for 60-second
 *  CPU burns. */
export const MAX_DIFFICULTY = 28;

/** Result shape for the GET endpoint. Client picks up the challenge,
 *  solves it, returns to POST. */
export interface PowChallenge {
  challenge: string; // hex (32 bytes)
  difficulty: number; // leading-zero bits required
  issuedAt: string; // ISO8601
  ttlSeconds: number; // server enforces; client should solve well within
}

/** Issue a fresh PoW challenge. Caller is responsible for storing the
 *  challenge + difficulty alongside an issuance timestamp + ipHash
 *  (we use the free_registration_log table for this). */
export function issueChallenge(
  args: {
    difficulty?: number;
    ttlSeconds?: number;
  } = {},
): PowChallenge {
  const difficulty = clamp(
    args.difficulty ?? DEFAULT_DIFFICULTY,
    1,
    MAX_DIFFICULTY,
  );
  return {
    challenge: randomBytes(32).toString("hex"),
    difficulty,
    issuedAt: new Date().toISOString(),
    ttlSeconds: args.ttlSeconds ?? 300,
  };
}

/**
 * Verify a (challenge, nonce, difficulty) tuple. Returns true if
 * sha256(challenge || nonce) has at least `difficulty` leading zero
 * BITS.
 *
 * Why bit-level not nibble-level: gives finer-grained difficulty
 * tuning. Difficulty=20 is half the work of difficulty=21, not the
 * 16× jump nibble-level would impose.
 */
export function verifySolution(args: {
  challenge: string;
  nonce: string;
  difficulty: number;
}): boolean {
  const hash = createHash("sha256")
    .update(args.challenge)
    .update(args.nonce)
    .digest();
  return countLeadingZeroBits(hash) >= args.difficulty;
}

/** Bit-level leading-zero counter on a buffer. Used by verifySolution
 *  AND by the CLI's solver to know when to stop. */
export function countLeadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    // Count leading zeros in this non-zero byte.
    let mask = 0x80;
    while ((byte & mask) === 0) {
      bits++;
      mask >>= 1;
    }
    break;
  }
  return bits;
}

/** Reference solver — used by tests and the CLI. Naive linear search;
 *  good enough at d=20 (~1s on modern CPU). */
export function solve(args: {
  challenge: string;
  difficulty: number;
  /** Optional iteration cap to prevent runaway in tests. */
  maxIterations?: number;
}): { nonce: string; iterations: number } {
  const max = args.maxIterations ?? 100_000_000;
  for (let i = 0; i < max; i++) {
    const nonce = i.toString(16);
    if (
      verifySolution({
        challenge: args.challenge,
        nonce,
        difficulty: args.difficulty,
      })
    ) {
      return { nonce, iterations: i + 1 };
    }
  }
  throw new Error(`PoW solve exceeded ${max} iterations`);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Sha256 hash of an IP address (or any string). Used to anchor
 *  per-IP rate limit accounting without storing raw IPs. */
export function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}
