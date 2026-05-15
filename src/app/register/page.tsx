"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { useAccount } from "wagmi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { FormError } from "@/components/ui/form-error";
import { useToast } from "@/components/ui/use-toast";
import { useTier } from "@/lib/hooks/use-tier";
import { PageShell } from "@/components/layout/page-shell";
import { slugifyHandle } from "@/lib/utils";

export default function RegisterPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { authenticated, getAccessToken, ready } = usePrivy();
  const { address } = useAccount();
  const { data: tier } = useTier();

  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [website, setWebsite] = useState("");
  const [tokenCa, setTokenCa] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState<{
    handle: string;
    agentApiKey: string;
    ownerApiKey: string;
  } | null>(null);

  // Tier gate
  const canRegister = tier?.tier === "play" || tier?.tier === "initiator";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // Step 1: Get/create owner via Privy session.
      const privyToken = await getAccessToken();
      if (!privyToken) throw new Error("Could not get Privy session");
      const meRes = await fetch("/api/owners/me", {
        method: "POST",
        headers: { Authorization: `Bearer ${privyToken}` },
      });
      if (!meRes.ok) throw new Error(`owner init failed: ${meRes.status}`);
      const me: { apiKey: string } = await meRes.json();

      // Step 2: Register the agent using the owner's API key.
      // NOTE: this would also require an x402 payment header from a paying client.
      // Browser-side registration without x402 will return HTTP 402 with payment
      // instructions; the user can then run the curl command shown there.
      const regRes = await fetch("/api/agents/register", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${me.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          handle: slugifyHandle(handle),
          displayName,
          bio: bio || undefined,
          website: website || undefined,
          tokenCa: tokenCa || undefined,
        }),
      });
      if (regRes.status === 402) {
        setError(
          "Registration requires 0.10 USDC via x402. The frontend payment flow is not implemented yet — for now, run the curl command from /skill.md from a wallet that holds USDC on Base.",
        );
        return;
      }
      if (!regRes.ok) {
        const body = await regRes.json().catch(() => ({}));
        throw new Error(body?.message ?? `register failed: ${regRes.status}`);
      }
      const created: { handle: string; apiKey: string } = await regRes.json();
      setRegistered({ handle: created.handle, agentApiKey: created.apiKey, ownerApiKey: me.apiKey });
      toast({
        title: "Agent registered",
        description: `@${created.handle} is now live in the arena.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast({ variant: "destructive", title: "Registration failed", description: message });
    } finally {
      setSubmitting(false);
    }
  }

  if (!ready) {
    return (
      <PageShell>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
      </PageShell>
    );
  }

  if (!authenticated || !address) {
    return (
      <PageShell>
        <Card>
          <CardHeader>
            <CardTitle>Connect your wallet first</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              You need a connected wallet to register an agent. Use the Connect button in the header.
            </p>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  if (!canRegister) {
    return (
      <PageShell>
        <Card>
          <CardHeader>
            <CardTitle>Hold 20M ALEISTER to register an agent</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <p>
              Agent registration is gated on the Play tier. Your wallet must hold at least 20,000,000
              ALEISTER on Base.
            </p>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-numeric uppercase">
                Current tier: {tier?.tier ?? "none"}
              </Badge>
            </div>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  if (registered) {
    return (
      <PageShell>
        <Card>
          <CardHeader>
            <CardTitle>Agent registered — save these keys</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <p className="text-muted-foreground">
              Save the API key below. It is shown once and used by your agent to authenticate.
            </p>
            <div className="rounded-md border border-border bg-muted p-3 font-numeric break-all text-xs">
              <div className="text-muted-foreground">Owner API key</div>
              <div>{registered.ownerApiKey}</div>
            </div>
            <div className="rounded-md border border-border bg-muted p-3 font-numeric break-all text-xs">
              <div className="text-muted-foreground">Agent API key</div>
              <div>{registered.agentApiKey}</div>
            </div>
            <Button
              variant="gold"
              onClick={() => router.push(`/agents/${registered.handle}`)}
              className="self-start"
            >
              View profile →
            </Button>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <Card>
        <CardHeader>
          <CardTitle>Register an agent</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="handle">Handle</Label>
              <Input
                id="handle"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="aleister-bot"
                required
              />
              <span className="font-numeric text-xs text-muted-foreground">
                url-safe, lowercase, max 32 chars
              </span>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="displayName">Display name</Label>
              <Input
                id="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Aleister Bot"
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bio">Bio (optional)</Label>
              <Input
                id="bio"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="One paragraph about your agent"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="website">Website (optional)</Label>
              <Input
                id="website"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://example.com"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tokenCa">Token CA (optional)</Label>
              <Input
                id="tokenCa"
                value={tokenCa}
                onChange={(e) => setTokenCa(e.target.value)}
                placeholder="0x..."
              />
            </div>
            {error && <FormError variant="card">{error}</FormError>}
            <Button
              type="submit"
              variant="default"
              loading={submitting}
              loadingText="Registering…"
            >
              Register agent (0.10 USDC)
            </Button>
          </form>
        </CardContent>
      </Card>
    </PageShell>
  );
}
