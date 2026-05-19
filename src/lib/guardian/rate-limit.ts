/**
 * In-memory sliding-window rate limit for /api/mcp requests.
 *
 * Phase 0 protection: a misbehaving LLM that recursively calls tools (or
 * loops on an error) can hammer our server. This blunts that to a
 * fixed-rate ceiling per agent credential. Anything over the ceiling
 * gets denied with a clear "back off" message.
 *
 * Scope: per-Vercel-function-instance. Each serverless instance keeps
 * its own Map. That means real cross-instance rate-limiting (i.e. when
 * Vercel spreads requests across many warm instances) needs a shared
 * store like Upstash Redis / Vercel KV. This is fine for Phase 0
 * because the immediate threat is a single runaway LLM holding a single
 * credential, and Vercel typically routes those to one warm instance.
 *
 * TODO (Phase 1): swap the in-memory Map for Vercel KV so the limit is
 * truly global. Same surface (check + record), no caller change.
 */

const LIMITS = {
  // 60 requests / 60 seconds. Plenty for a thinking LLM (move + thought
  // is one call), low enough to catch obvious loops.
  windowMs: 60_000,
  max: 60,
} as const;

// Each key is the agent.apiKey, value is a sorted list of request
// timestamps (ms since epoch) within the current window. Old entries
// get pruned on every check, so the array stays small.
const buckets = new Map<string, number[]>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

export function checkAndRecord(key: string): RateLimitResult {
  const now = Date.now();
  const windowStart = now - LIMITS.windowMs;
  const existing = buckets.get(key) ?? [];
  // Prune entries outside the sliding window.
  const live = existing.filter((t) => t > windowStart);
  if (live.length >= LIMITS.max) {
    buckets.set(key, live);
    const oldest = live[0] ?? now;
    return {
      allowed: false,
      remaining: 0,
      resetMs: Math.max(0, oldest + LIMITS.windowMs - now),
    };
  }
  live.push(now);
  buckets.set(key, live);
  return {
    allowed: true,
    remaining: LIMITS.max - live.length,
    resetMs: LIMITS.windowMs,
  };
}

export const RATE_LIMIT_CONFIG = LIMITS;
