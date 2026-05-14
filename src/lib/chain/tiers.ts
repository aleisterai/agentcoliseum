/**
 * Cached tier lookup. Server-side only.
 *
 * Reads `tier_cache` first; if the row is fresh (< 60s), returns it.
 * Otherwise falls through to a live RPC read, persists, and returns.
 *
 * Caller is responsible for not exposing this on the client (network roundtrip
 * + DB write — keep it inside API route handlers and server components).
 */
import "server-only";
import { eq } from "drizzle-orm";
import { getAddress, type Address } from "viem";
import { db } from "@/lib/db/client";
import { tierCache } from "@/lib/db/schema";
import { getTier, type Tier } from "./aleister";

const TTL_MS = 60_000;

export type TierResult = {
  wallet: Address;
  tier: Tier;
  balanceWei: bigint;
  cachedAt: Date;
  fromCache: boolean;
};

/** Look up a wallet's tier, using the 60-second cache when fresh. */
export async function lookupTier(wallet: Address): Promise<TierResult> {
  const checksummed = getAddress(wallet);

  // 1. Check cache.
  const cached = await db.query.tierCache.findFirst({
    where: eq(tierCache.walletAddress, checksummed),
  });
  if (cached && Date.now() - cached.cachedAt.getTime() < TTL_MS) {
    return {
      wallet: checksummed,
      tier: cached.tier as Tier,
      balanceWei: BigInt(cached.balanceWei),
      cachedAt: cached.cachedAt,
      fromCache: true,
    };
  }

  // 2. Cache miss / stale — fetch live and persist.
  const { balanceWei, tier } = await getTier(checksummed);
  const now = new Date();
  await db
    .insert(tierCache)
    .values({
      walletAddress: checksummed,
      balanceWei: balanceWei.toString(),
      tier,
      cachedAt: now,
    })
    .onConflictDoUpdate({
      target: tierCache.walletAddress,
      set: {
        balanceWei: balanceWei.toString(),
        tier,
        cachedAt: now,
      },
    });

  return { wallet: checksummed, tier, balanceWei, cachedAt: now, fromCache: false };
}

/** Hard tier-gate for API routes. Throws a typed error if the wallet is under-tier. */
export async function requireTier(wallet: Address, min: Tier): Promise<TierResult> {
  const result = await lookupTier(wallet);
  if (!atLeast(result.tier, min)) {
    throw new TierInsufficientError(min, result.tier);
  }
  return result;
}

export function atLeast(have: Tier, need: Tier): boolean {
  const order: Record<Tier, number> = { none: 0, play: 1, initiator: 2 };
  return order[have] >= order[need];
}

export class TierInsufficientError extends Error {
  readonly required: Tier;
  readonly actual: Tier;
  constructor(required: Tier, actual: Tier) {
    super(`Insufficient tier: have ${actual}, need ${required}`);
    this.name = "TierInsufficientError";
    this.required = required;
    this.actual = actual;
  }
}
