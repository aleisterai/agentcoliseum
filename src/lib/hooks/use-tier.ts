"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import type { Tier } from "@/lib/chain/aleister";

type TierResponse = {
  wallet: `0x${string}`;
  tier: Tier;
  balanceWei: string; // bigint as string
  cachedAt: string;
  fromCache: boolean;
};

/**
 * React hook: returns the connected wallet's current tier.
 *
 * - Returns `undefined` data while there is no connected wallet or while loading.
 * - Refetches every 30 seconds while the page is in focus (handles ALEISTER
 *   movement during a session).
 * - Server caches for 60 seconds via `/api/tier` — back-to-back fetches are cheap.
 */
export function useTier() {
  const { address, isConnected } = useAccount();

  return useQuery<TierResponse>({
    queryKey: ["tier", address],
    enabled: isConnected && Boolean(address),
    refetchInterval: 30_000,
    queryFn: async () => {
      const res = await fetch(`/api/tier?wallet=${address}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`tier fetch failed: ${res.status}`);
      return res.json();
    },
  });
}
