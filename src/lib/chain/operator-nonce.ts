/**
 * Per-process nonce manager for the operator wallet.
 *
 * Without this, two concurrent server-side writes (e.g., settlement-
 * sweep and tournament-progression both running at minute :00) can
 * each call viem's writeContract / sendTransaction, both fetch the
 * same `pending` nonce from RPC, and one tx will be rejected with
 * "nonce too low" once the other lands.
 *
 * The manager solves this by:
 *   1. Serializing operator writes through a single in-flight
 *      promise (mutex-equivalent on Node's single thread).
 *   2. Tracking the next nonce in memory, optimistically incrementing
 *      after submit.
 *   3. Refreshing the nonce from RPC after any failure so we don't
 *      get stuck on a phantom incremented value.
 *
 * Limits:
 *   - Per-process. Multiple Vercel instances each maintain their
 *     own counter. Two instances submitting concurrently can still
 *     collide. Mitigation: track lastNoncePersistedAt in Redis and
 *     coordinate cross-instance. Sprint 21 if we see a real problem.
 *   - Serialized = ~one tx per 2s block. Throughput ceiling is ~1800
 *     tx/hour. Real scaling needs per-agent wallets (Phase 4 in the
 *     build plan).
 *
 * Usage:
 *   const txHash = await submitOperatorTx((nonce) =>
 *     wallet.writeContract({
 *       address: USDC_BASE,
 *       abi: erc20Abi,
 *       functionName: "transfer",
 *       args: [to, amount],
 *       nonce,
 *       chain: base,
 *       account: wallet.account,
 *     }),
 *   );
 */
import "server-only";
import { publicClient } from "./viem";
import { getOperatorAddress } from "./wallet";

class OperatorNonceManager {
  private nextNonce: number | null = null;
  // Single rolling promise — every withLock waits on the previous one.
  // Node is single-threaded so this is sufficient for in-process
  // mutual exclusion.
  private chain: Promise<unknown> = Promise.resolve();

  async withNonce<T>(fn: (nonce: number) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.nextNonce === null) {
        // First use OR post-failure refresh. blockTag: "pending"
        // includes in-flight tx so we don't reuse a nonce that just
        // got submitted by another process.
        this.nextNonce = await publicClient.getTransactionCount({
          address: getOperatorAddress(),
          blockTag: "pending",
        });
      }
      const nonceToUse = this.nextNonce;
      this.nextNonce++; // optimistic — we'll roll back below if the tx fails
      try {
        const result = await fn(nonceToUse);
        return result;
      } catch (err) {
        // Re-fetch from RPC so we don't get stuck on a phantom counter.
        // The next withNonce call will pick up the fresh value.
        try {
          this.nextNonce = await publicClient.getTransactionCount({
            address: getOperatorAddress(),
            blockTag: "pending",
          });
        } catch {
          // RPC blip during refresh — fall back to lazy fetch on next call.
          this.nextNonce = null;
        }
        throw err;
      }
    };

    // Chain this run onto the current tail. Each call waits for the
    // previous one to settle (resolve OR reject — we still proceed).
    const previous = this.chain;
    const current = previous.then(run, run);
    // Track the LATEST promise as the new tail. Errors don't propagate
    // through chain — each caller gets their own promise back from
    // current.
    this.chain = current.catch(() => undefined);
    return current;
  }

  /** Force-refresh the next nonce from RPC. Useful after a manual
   * tx (e.g. operator manually sent something via Basescan) to
   * resync. Auto-refresh happens on failure anyway. */
  async refresh(): Promise<void> {
    this.nextNonce = await publicClient.getTransactionCount({
      address: getOperatorAddress(),
      blockTag: "pending",
    });
  }
}

const manager = new OperatorNonceManager();

/**
 * submitOperatorTx — the canonical entry point for any write from
 * the operator wallet. Pass a builder that takes the nonce and
 * returns viem's tx-hash promise. The manager serializes calls +
 * supplies the next nonce + handles RPC-refresh on failure.
 */
export async function submitOperatorTx<T>(
  fn: (nonce: number) => Promise<T>,
): Promise<T> {
  return manager.withNonce(fn);
}

export async function refreshOperatorNonce(): Promise<void> {
  return manager.refresh();
}
