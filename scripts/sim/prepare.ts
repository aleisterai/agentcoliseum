/**
 * prepare.ts — pre-flight DB tier refresh.
 *
 * `mode: "system"` propose requires the calling agent to be in the
 * Play tier (≥ 20M $ALEISTER held by their linked wallet). Free-tier
 * test agents (alpha/beta) don't actually hold that — the existing
 * pattern in scripts/coliseum-game-sweep.test.ts pre-warms the
 * tier_cache table with a "play" entry that the requirePlayAccess
 * check reads BEFORE going on-chain.
 *
 * This module mirrors that pattern so the sim can drive system-mode
 * matches against production cleanly. Refresh once at startup;
 * `TTL_MS = 60_000` in src/lib/chain/tiers.ts means we need to
 * re-warm every ~50s during a long run. For now we re-warm once at
 * sim start — the cache survives long enough to get through the
 * smoke runs; if a long run hits tier_below_play mid-loop, the
 * caller can run prepare again.
 *
 * Requires DATABASE_URL — the sim CLI is invoked via
 * `--env-file=.env.local` to pick it up. If DATABASE_URL is unset
 * we skip the refresh and emit a warning (sim will likely fail at
 * propose for free agents).
 */

import { eq } from "drizzle-orm";
import { getAddress } from "viem";

/**
 * Last refresh time per agentId. The server's tier_cache TTL is 60s
 * (see src/lib/chain/tiers.ts:17 → TTL_MS = 60_000). A chess or
 * checkers match easily runs > 60s, so the refresh from sim startup
 * stales out mid-run. The runner calls `maybeRefreshTier` before
 * every propose to re-warm if > 50s has passed; this map memoises
 * the last refresh wall-clock per agent.
 */
const lastRefreshMs = new Map<string, number>();

/** Internal — does the actual upsert. */
async function doRefresh(
  agentId: string,
  label: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!process.env.DATABASE_URL) {
    return {
      ok: false,
      detail: "DATABASE_URL unset — skipping tier refresh",
    };
  }
  const { db, agents, owners, tierCache } = await import("@/lib/db/schema").then(
    async (schema) => {
      const client = await import("@/lib/db/client");
      return { db: client.db, ...schema };
    },
  );
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
  });
  if (!agent) return { ok: false, detail: `[${label}] agent ${agentId} not found in DB` };
  if (!agent.ownerId) {
    return {
      ok: false,
      detail: `[${label}] agent has no ownerId (free agent — system mode unavailable)`,
    };
  }
  const owner = await db.query.owners.findFirst({
    where: eq(owners.id, agent.ownerId),
  });
  if (!owner) return { ok: false, detail: `[${label}] owner not found` };
  const checksummed = getAddress(owner.walletAddress as `0x${string}`);
  const balanceWei = (20_000_000n * 10n ** 18n).toString();
  await db
    .insert(tierCache)
    .values({
      walletAddress: checksummed,
      balanceWei,
      tier: "play",
      cachedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: tierCache.walletAddress,
      set: {
        balanceWei,
        tier: "play",
        cachedAt: new Date(),
      },
    });
  lastRefreshMs.set(agentId, Date.now());
  return {
    ok: true,
    detail: `[${label}] tier_cache → play (wallet ${checksummed.slice(0, 8)}…)`,
  };
}

/**
 * Refresh-if-stale. Returns the same shape as refreshTier(); if the
 * previous refresh was < 50s ago we return a `skipped` detail and
 * don't hit the DB.
 */
export async function maybeRefreshTier(
  agentId: string,
  label: string,
): Promise<{ ok: boolean; detail: string }> {
  const last = lastRefreshMs.get(agentId) ?? 0;
  if (Date.now() - last < 50_000) {
    return { ok: true, detail: `[${label}] tier_cache still fresh, skipping refresh` };
  }
  return doRefresh(agentId, label);
}

/** External one-shot — used at sim startup. Always re-runs. */
export async function refreshTier(
  agentId: string,
  label: string,
): Promise<{ ok: boolean; detail: string }> {
  return doRefresh(agentId, label);
}
