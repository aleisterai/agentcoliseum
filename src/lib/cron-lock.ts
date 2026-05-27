/**
 * Cross-instance cron mutex via Redis SETNX.
 *
 * Why this exists: Vercel runs cron functions on serverless instances
 * that may overlap if a tick runs into the next window. Without a
 * cross-instance lock, two `settlement-sweep` invocations can fire
 * concurrent operator-wallet transactions, and the per-process nonce
 * mutex in operator-nonce.ts won't catch the collision (it's
 * in-memory per Vercel instance).
 *
 * The lock model:
 *   - SET name NX EX ttl   — acquire if absent, with auto-expiry
 *   - DEL name              — release at end of work
 *   - TTL acts as a safety net: if a cron crashes without releasing,
 *     the next tick can re-acquire after the TTL window.
 *
 * Pick the TTL to be > maxDuration of the cron handler. Default 90s
 * works for 60-second crons with headroom.
 *
 * Falls back to NO LOCK (allow execution) if Redis is unavailable —
 * this is intentional. We'd rather have potential double-fires during
 * a Redis outage than miss critical settlement work entirely.
 */
import "server-only";
import { Redis } from "@upstash/redis";

function redisCreds(): { url: string; token: string } | null {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? null;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? null;
  if (!url || !token) return null;
  return { url, token };
}

let client: Redis | null = null;
function getClient(): Redis | null {
  if (client) return client;
  const creds = redisCreds();
  if (!creds) return null;
  client = new Redis({ url: creds.url, token: creds.token });
  return client;
}

/**
 * Try to acquire the lock named `cronName`. Returns true if this caller
 * got the lock (proceed with work + call release at end), false if
 * another instance holds it (skip this tick).
 *
 * Lock TTL defaults to 90s — set higher for long-running crons.
 * The TTL is the safety net for the "cron crashed without releasing"
 * case; the next tick blocks for up to that long before being able to
 * acquire.
 */
export async function tryAcquireCronLock(
  cronName: string,
  ttlSeconds: number = 90,
): Promise<boolean> {
  const redis = getClient();
  if (!redis) {
    // No Redis — fall through to allowing execution. Comments above
    // explain why we'd rather double-fire than starve.
    return true;
  }
  try {
    const key = `cron-lock:${cronName}`;
    // SET ... NX EX returns "OK" on success, null on conflict.
    const res = await redis.set(key, Date.now().toString(), {
      nx: true,
      ex: ttlSeconds,
    });
    return res === "OK";
  } catch (err) {
    console.warn(
      `[cron-lock] redis failure on ${cronName}, allowing execution:`,
      err,
    );
    return true;
  }
}

/**
 * Release the lock acquired by tryAcquireCronLock. Safe to call even
 * if the lock was never acquired (no-op on miss).
 *
 * Idempotent — calling release twice or releasing a lock that's
 * already expired is harmless.
 */
export async function releaseCronLock(cronName: string): Promise<void> {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.del(`cron-lock:${cronName}`);
  } catch {
    // Best-effort. If del fails the TTL will clean up.
  }
}

/**
 * Convenience wrapper for cron route handlers: try-acquire, run,
 * release. Returns a `Response` regardless of whether the lock was
 * acquired (the skip case returns a 200 with `{ok:true, skipped:true}`
 * so Vercel doesn't treat the tick as a failure).
 *
 * Usage:
 *   export async function GET(req: Request) {
 *     return withCronLock("settlement-sweep", () => doTheWork(req));
 *   }
 *
 * The inner fn MUST return a Response (or a Promise of one) — this
 * matches Next.js route handler signature. If you need a non-Response
 * return type, use tryAcquireCronLock + releaseCronLock manually.
 */
import { NextResponse } from "next/server";

export async function withCronLock(
  cronName: string,
  fn: () => Promise<Response> | Response,
  ttlSeconds: number = 90,
): Promise<Response> {
  const got = await tryAcquireCronLock(cronName, ttlSeconds);
  if (!got) {
    console.log(
      `[cron-lock] ${cronName} skipped — another instance holds lock`,
    );
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "lock held by another instance",
      cronName,
    });
  }
  try {
    return await fn();
  } finally {
    await releaseCronLock(cronName);
  }
}
