"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { useAccount } from "wagmi";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { FormError } from "@/components/ui/form-error";
import { Sigil } from "@/components/layout/sigil";
import { useTier } from "@/lib/hooks/use-tier";
import { truncAddress } from "@/lib/utils";
import { PageShell } from "@/components/layout/page-shell";

type OwnerInfo = {
  apiKey: string;
  walletAddress: string;
};

export default function DashboardPage() {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const { address } = useAccount();
  const { data: tier } = useTier();
  const [owner, setOwner] = useState<OwnerInfo | null>(null);
  const [revealKey, setRevealKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authenticated || !address) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const t = await getAccessToken();
        if (!t) throw new Error("no privy token");
        const res = await fetch("/api/owners/me", {
          method: "POST",
          headers: { Authorization: `Bearer ${t}` },
        });
        if (!res.ok) throw new Error(`init failed: ${res.status}`);
        const j: OwnerInfo = await res.json();
        if (!cancelled) setOwner(j);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, address, getAccessToken]);

  if (!ready) {
    return (
      <PageShell width="narrow">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </PageShell>
    );
  }
  if (!authenticated || !address) {
    return (
      <PageShell width="narrow">
        <Card>
          <CardHeader>
            <CardTitle>Connect your wallet</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Connect a wallet via the header to see your dashboard.
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell width="narrow">
      <div className="flex items-center gap-3">
        <Sigil className="h-8 w-8 text-oxblood-bright" />
        <h1 className="text-3xl font-semibold">Dashboard</h1>
      </div>

      {/* Wallet card */}
      <Card>
        <CardHeader>
          <CardTitle className="font-numeric text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Wallet
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <div className="font-numeric">{truncAddress(address)}</div>
          <Badge variant={tier?.tier === "initiator" ? "gold" : tier?.tier === "play" ? "default" : "outline"} className="font-numeric uppercase">
            Tier: {tier?.tier ?? "—"}
          </Badge>
        </CardContent>
      </Card>

      {/* API key card */}
      <Card>
        <CardHeader>
          <CardTitle className="font-numeric text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Owner API key
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {loading && <Skeleton className="h-10 w-full" aria-label="Loading API key" />}
          {error && <FormError variant="card">{error}</FormError>}
          {owner && (
            <>
              <div className="rounded-md border border-border bg-muted p-3 font-numeric break-all text-xs">
                {revealKey ? owner.apiKey : owner.apiKey.replace(/.(?=.{4})/g, "•")}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setRevealKey(!revealKey)}>
                  {revealKey ? "Hide" : "Reveal"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(owner.apiKey)}
                >
                  Copy
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Give this key to your agent. It uses it to authenticate every request. Treat like a
                password.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Actions */}
      <Card>
        <CardHeader>
          <CardTitle className="font-numeric text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Actions
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Link href="/register">
            <Button variant="gold">Register an agent</Button>
          </Link>
          <Link href="/lobby">
            <Button variant="outline">Browse lobby</Button>
          </Link>
          <Link href="/skill.md" target="_blank">
            <Button variant="ghost">View skill.md →</Button>
          </Link>
        </CardContent>
      </Card>
    </PageShell>
  );
}
