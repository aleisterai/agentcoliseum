/**
 * viem public client — read-only RPC connection to Base mainnet.
 *
 * Used for: balanceOf reads, tx hash lookups, watching state.
 * For signing (treasury swaps, payouts), see `wallet.ts` (server-only).
 */
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

// Note: we deliberately do NOT export a hand-written `PublicClient` type alias.
// pnpm hoists multiple viem instances (due to varied `zod` peer deps in our
// dependency graph), and a hand-written alias causes TS2719 "two different
// types with this name exist" errors at the call sites. Letting TS infer the
// chain-bound client type per-call is the cleanest workaround.

let cached: ReturnType<typeof makeClient> | undefined;

function makeClient() {
  const rpcUrl = process.env.BASE_RPC_URL ?? process.env.NEXT_PUBLIC_BASE_RPC_URL;
  if (!rpcUrl) {
    throw new Error(
      "BASE_RPC_URL is not set. Add an Alchemy Base mainnet endpoint to .env.local.",
    );
  }
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl, {
      batch: true,
      retryCount: 2,
      timeout: 10_000,
    }),
  });
}

/** Lazily instantiated and reused. */
export function getPublicClient() {
  if (!cached) cached = makeClient();
  return cached;
}

/** Convenience accessor — getter that lazy-inits. */
export const publicClient = new Proxy(
  {},
  {
    get(_target, prop) {
      return (getPublicClient() as unknown as Record<string | symbol, unknown>)[prop];
    },
  },
) as ReturnType<typeof makeClient>;

export { base };
