/**
 * Per-credential rate limit for /api/mcp requests.
 *
 * Uses the shared lib/cache.ts abstraction so the same limiter is
 * cross-instance in production (KV-backed) and still works in dev
 * without KV credentials (memory-backed sliding window).
 *
 * Before Sprint 17 this was an in-memory Map only, which means a
 * Vercel function instance with a hot pool could under-count
 * relative to another instance and effectively let a runaway LLM
 * sneak past the limit. KV fixes that with a fixed-window-with-grace
 * approximation good enough for spam-stop. (Sliding window is more
 * precise; we can pay the extra commands if needed later.)
 */
import { rateLimitCheck, type RateLimitResult } from "@/lib/cache";

const LIMITS = {
  // 60 requests / 60 seconds. Plenty for a thinking LLM (move + thought
  // is one call), low enough to catch obvious loops.
  windowMs: 60_000,
  max: 60,
} as const;

export async function checkAndRecord(key: string): Promise<RateLimitResult> {
  return rateLimitCheck(`mcp:${key}`, LIMITS.windowMs, LIMITS.max);
}

export const RATE_LIMIT_CONFIG = LIMITS;
