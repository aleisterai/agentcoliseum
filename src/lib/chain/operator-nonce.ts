/**
 * Cross-instance + in-process nonce manager for the operator wallet.
 *
 * **The two layers of mutex.**
 *
 *   Layer 1 (in-process). Node is single-threaded, so a rolling
 *   Promise-chain serializes operator writes within ONE Vercel
 *   instance. Cheap.
 *
 *   Layer 2 (cross-instance). Vercel runs many serverless instances.
 *   Two of them can each call submitOperatorTx concurrently and
 *   collide on the next pending-nonce read from RPC. To prevent that
 *   we acquire a Redis lock (`operator-tx-lock`) before fetching the
 *   nonce, and release it after the tx settles. Lock TTL acts as a
 *   crash-recovery safety net.
 *
 * **Why we read the nonce fresh from RPC every time (no shared counter).**
 *
 * A shared Redis counter is faster (no per-tx RPC roundtrip) but
 * leaves holes if a process crashes between INCR-claim and actual
 * submit. Holes brick subsequent txs until the gap is filled. The
 * lock-and-read-fresh pattern is ~50-100ms slower per tx but is
 * self-healing: if a tx fails or a process dies, the next call just
 * reads the live `pending` nonce from RPC and proceeds.
 *
 * At ~1800 tx/hour ceiling (one every 2s), 100ms of RPC time per tx
 * is acceptable. If volume grows past that, switch to a single
 * dedicated operator-tx queue cron (per architect review).
 *
 * **Lock failure semantics.**
 *
 * If Redis is unavailable, we fall through to in-process-only mode
 * with a console.warn. This is the same trade-off as cron-lock.ts:
 * we'd rather risk occasional cross-instance collisions than starve
 * settlement / refund / tournament writes entirely during a Redis
 * outage. The in-process mutex still protects against self-collision.
 *
 * Usage:
 *   const txHash = await submitOperatorTx((nonce) =>
 *     wallet.writeContract({ address, abi, functionName, args, nonce, chain, account }),
 *   );
 */
import "server-only";
import { Redis } from "@upstash/redis";
import { publicClient } from "./viem";
import { getOperatorAddress } from "./wallet";

const LOCK_KEY = "operator-tx-lock";
const LOCK_TTL_SECONDS = 30;
const LOCK_WAIT_MAX_MS = 25_000;
const LOCK_POLL_INTERVAL_MS = 100;

// ────────────────────────────────────────────────────────────────────
// Redis client (lazy, optional)
// ────────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────────
// Cross-instance lock
// ────────────────────────────────────────────────────────────────────

async function acquireRedisLock(): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    // No Redis configured — proceed without cross-instance protection.
    // The in-process mutex still applies; cross-instance collision is
    // possible but rare and self-healing (failed tx → fresh RPC read).
    return true;
  }
  const deadline = Date.now() + LOCK_WAIT_MAX_MS;
  while (Date.now() < deadline) {
    try {
      const res = await redis.set(LOCK_KEY, Date.now().toString(), {
        nx: true,
        ex: LOCK_TTL_SECONDS,
      });
      if (res === "OK") return true;
    } catch (err) {
      console.warn("[operator-nonce] redis lock acquire failed:", err);
      // Fall through to in-process-only mode rather than block forever.
      return true;
    }
    // Brief poll wait — long enough not to thrash, short enough that
    // the typical tx-submit handoff is < 1s.
    await new Promise((r) => setTimeout(r, LOCK_POLL_INTERVAL_MS));
  }
  // Couldn't get the lock within LOCK_WAIT_MAX_MS. Proceed anyway —
  // the alternative is starving the cron, and the in-process mutex
  // still prevents self-collision. The owner of the lock will release
  // it (or it'll TTL) and the next call will get it cleanly.
  console.warn(
    `[operator-nonce] lock wait exceeded ${LOCK_WAIT_MAX_MS}ms — proceeding without cross-instance lock`,
  );
  return true;
}

async function releaseRedisLock(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(LOCK_KEY);
  } catch {
    // Best-effort. The TTL will clean up.
  }
}

// ────────────────────────────────────────────────────────────────────
// In-process serialization (Node-thread-local mutex)
// ────────────────────────────────────────────────────────────────────

class OperatorNonceManager {
  // Rolling Promise chain. Each call awaits the previous one.
  private chain: Promise<unknown> = Promise.resolve();

  async withNonce<T>(fn: (nonce: number) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await acquireRedisLock();
      try {
        // Always read fresh from RPC — no shared counter to corrupt.
        const nonce = await publicClient.getTransactionCount({
          address: getOperatorAddress(),
          blockTag: "pending",
        });
        return await fn(nonce);
      } finally {
        await releaseRedisLock();
      }
    };

    // Chain onto the current tail; each call waits for the previous
    // one to settle (resolve OR reject — we still proceed).
    const previous = this.chain;
    const current = previous.then(run, run);
    // Track the latest promise as the new tail. Errors don't propagate
    // through chain — each caller gets their own promise back from
    // `current`.
    this.chain = current.catch(() => undefined);
    return current;
  }

  /** Force-release the Redis lock. Useful if the operator manually
   *  acquired it (e.g. via Basescan UI) and wants to free it. */
  async forceUnlock(): Promise<void> {
    await releaseRedisLock();
  }
}

const manager = new OperatorNonceManager();

/**
 * submitOperatorTx — the canonical entry point for any write from the
 * operator wallet. Pass a builder that takes the nonce and returns
 * viem's tx-hash promise. The manager:
 *
 *   1. Waits its turn in the in-process Promise chain (one tx at a
 *      time within this Node instance).
 *   2. Acquires the Redis cross-instance lock (serializes across
 *      all Vercel instances).
 *   3. Reads the next pending nonce live from Base RPC.
 *   4. Runs your builder with that nonce.
 *   5. Releases the Redis lock when fn settles (success or failure).
 */
export async function submitOperatorTx<T>(
  fn: (nonce: number) => Promise<T>,
): Promise<T> {
  return manager.withNonce(fn);
}

export async function forceReleaseOperatorLock(): Promise<void> {
  return manager.forceUnlock();
}

/**
 * Kept for backward compat with the old API. No-op under the new
 * read-fresh-every-time model — there's no in-memory counter to refresh.
 */
export async function refreshOperatorNonce(): Promise<void> {
  // No-op. The nonce is read fresh from RPC inside withNonce.
}
