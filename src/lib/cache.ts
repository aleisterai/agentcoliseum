/**
 * Tiny Redis-or-memory cache abstraction.
 *
 * Backed by Upstash Redis (@upstash/redis) when UPSTASH_REDIS_REST_URL
 * + UPSTASH_REDIS_REST_TOKEN env vars are set. Falls back to a
 * per-process in-memory Map with TTL otherwise. Vercel KV uses the
 * same env-var shape (KV_REST_API_URL / KV_REST_API_TOKEN) under
 * the hood, so we read both names — either one works.
 *
 * This makes local dev work without Redis credentials AND lets prod
 * automatically get cross-instance caching the moment the env vars
 * land in Vercel's dashboard — no code change needed.
 *
 * Surface:
 *   cacheGet<T>(key)                       null on miss
 *   cacheSet(key, value, ttlSeconds)
 *   cacheDel(key)
 *   memoize(key, ttlSeconds, fn)           wrap an async fn to cache result
 *   rateLimitCheck(key, windowMs, max)     fixed-window-with-grace via INCR
 *
 * For hot-page caching (/api/feed, /api/telemetry, ERC-20 metadata),
 * memoize is the primary entry point.
 */
import "server-only";
import { Redis } from "@upstash/redis";

const memoryStore = new Map<string, { value: unknown; expiresAt: number }>();

function redisCreds(): { url: string; token: string } | null {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? null;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? null;
  if (!url || !token) return null;
  return { url, token };
}

let cachedClient: Redis | null = null;
function getRedis(): Redis | null {
  if (cachedClient) return cachedClient;
  const creds = redisCreds();
  if (!creds) return null;
  cachedClient = new Redis({ url: creds.url, token: creds.token });
  return cachedClient;
}

export async function cacheGet<T = unknown>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (redis) {
    try {
      const v = await redis.get<T>(key);
      return v ?? null;
    } catch {
      // Redis unreachable → fall through to memory cache to avoid an
      // outage taking down hot pages.
    }
  }
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value as T;
}

export async function cacheSet<T>(
  key: string,
  value: T,
  ttlSeconds: number,
): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(key, value, { ex: ttlSeconds });
      return;
    } catch {
      // Redis write failed — still set memory cache so this process
      // serves a fast response even if Redis is down.
    }
  }
  memoryStore.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

export async function cacheDel(key: string): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(key);
    } catch {
      // ignore
    }
  }
  memoryStore.delete(key);
}

/**
 * memoize — async-function-around cache with TTL. The wrapped fn runs
 * AT MOST once per `ttlSeconds` window per key. Concurrent callers
 * within a single process share a single in-flight promise via the
 * pending map so we don't N×-stampede when a popular cache key expires.
 */
const pending = new Map<string, Promise<unknown>>();

export async function memoize<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) return cached;
  // Single-flight in-process — if another request is already filling
  // this key, wait on its promise rather than firing a duplicate fn.
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const p = (async () => {
    try {
      const value = await fn();
      await cacheSet(key, value, ttlSeconds);
      return value;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, p);
  return p;
}

/**
 * Sliding-window rate limit. Returns { allowed, remaining, resetMs }.
 *
 * Implementation: KV uses INCR + EXPIRE on a per-window key, which gives
 * a fixed-window-with-grace approximation (good enough for spam-stop).
 * Memory fallback uses the existing array-of-timestamps approach for
 * accuracy.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

const memoryBuckets = new Map<string, number[]>();

export async function rateLimitCheck(
  key: string,
  windowMs: number,
  max: number,
): Promise<RateLimitResult> {
  const redis = getRedis();
  if (redis) {
    try {
      const windowKey = `rl:${key}:${Math.floor(Date.now() / windowMs)}`;
      const count = await redis.incr(windowKey);
      if (count === 1) {
        await redis.expire(windowKey, Math.ceil(windowMs / 1000));
      }
      const remaining = Math.max(0, max - count);
      const resetMs = (Math.floor(Date.now() / windowMs) + 1) * windowMs - Date.now();
      return { allowed: count <= max, remaining, resetMs };
    } catch {
      // Redis failure → fall through to memory limit
    }
  }
  // Memory sliding-window
  const now = Date.now();
  const start = now - windowMs;
  const existing = memoryBuckets.get(key) ?? [];
  const live = existing.filter((t) => t > start);
  if (live.length >= max) {
    memoryBuckets.set(key, live);
    const oldest = live[0] ?? now;
    return {
      allowed: false,
      remaining: 0,
      resetMs: Math.max(0, oldest + windowMs - now),
    };
  }
  live.push(now);
  memoryBuckets.set(key, live);
  return { allowed: true, remaining: max - live.length, resetMs: windowMs };
}

export function isRedisAvailable(): boolean {
  return redisCreds() !== null;
}
