"use client";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useTier } from "@/lib/hooks/use-tier";
import { formatTokenShort } from "@/lib/utils";
import { ALEISTER_DECIMALS } from "@/lib/chain/aleister";

/**
 * Tier badge for the connected wallet. Renders one of:
 *   "Tier: Initiator · 12.3M ALEISTER"  (gold)
 *   "Tier: Play · 22.5M ALEISTER"        (oxblood)
 *   "Hold 20M ALEISTER to play"          (muted outline)
 *   loading skeleton                     (muted pulse)
 *
 * Returns null when no wallet is connected.
 */
export function TierBadge() {
  const { data, isLoading, isError } = useTier();

  if (!isLoading && !data && !isError) return null;

  if (isLoading) {
    return <Skeleton className="h-6 w-32" aria-label="Reading chain balance" />;
  }

  if (isError || !data) {
    return (
      <Badge variant="outline" className="border-destructive/40 text-destructive">
        <span className="font-numeric text-xs">tier check failed</span>
      </Badge>
    );
  }

  const formatted = formatTokenShort(BigInt(data.balanceWei), ALEISTER_DECIMALS);

  if (data.tier === "initiator") {
    return (
      <Badge variant="gold" className="font-numeric uppercase tracking-wider">
        Initiator · {formatted}
      </Badge>
    );
  }
  if (data.tier === "play") {
    return (
      <Badge variant="default" className="font-numeric uppercase tracking-wider">
        Play · {formatted}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="font-numeric uppercase tracking-wider text-muted-foreground">
      Hold 20M ALEISTER · {formatted}
    </Badge>
  );
}
