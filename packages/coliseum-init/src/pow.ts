/**
 * Client-side proof-of-work solver. Mirrors the algorithm in
 * `src/lib/pow/index.ts` on the server — keep them in lockstep.
 *
 * The CLI fetches a challenge from `GET /api/agents/register/free/challenge`,
 * solves locally via this module, and posts back to
 * `POST /api/agents/register/free`. The server re-verifies with one
 * sha256.
 */
import { createHash } from "node:crypto";

/** Returns true iff sha256(challenge || nonce) has ≥ difficulty
 *  leading zero BITS. Bit-level (not nibble-level) so difficulty
 *  steps are 2× cost per +1 — finer-grained than 16× nibble steps. */
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

export function countLeadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    let mask = 0x80;
    while ((byte & mask) === 0) {
      bits++;
      mask >>= 1;
    }
    break;
  }
  return bits;
}

/**
 * Solve the PoW. Linear hex-nonce search, hashes-per-second-tunable.
 * At default difficulty 20 (~1M hashes expected), this is ~1 second
 * on a modern CPU. Progress callback is invoked every `progressEvery`
 * iterations so the UI can render a spinner without spending CPU on
 * itself.
 */
export function solve(args: {
  challenge: string;
  difficulty: number;
  maxIterations?: number;
  onProgress?: (iterations: number) => void;
  progressEvery?: number;
}): { nonce: string; iterations: number; elapsedMs: number } {
  const start = Date.now();
  const max = args.maxIterations ?? 200_000_000;
  const tick = args.progressEvery ?? 200_000;
  for (let i = 0; i < max; i++) {
    if (args.onProgress && i > 0 && i % tick === 0) {
      args.onProgress(i);
    }
    const nonce = i.toString(16);
    if (
      verifySolution({
        challenge: args.challenge,
        nonce,
        difficulty: args.difficulty,
      })
    ) {
      return { nonce, iterations: i + 1, elapsedMs: Date.now() - start };
    }
  }
  throw new Error(
    `PoW solve exceeded ${max.toLocaleString()} iterations at difficulty ${args.difficulty}`,
  );
}
