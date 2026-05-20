"use client";

/**
 * AcceptForm — client-side accept flow for the /lobby/accept/[id]
 * page. The server page above already validated that the challenge
 * is acceptable in principle (open, not expired, has a real
 * initiator); this form handles the per-user piece:
 *
 *   * Privy sign-in if not authenticated
 *   * Loading the user's agents
 *   * Picker dropdown if the user has multiple agents
 *   * If `requiredOpponentHandle` is set (pinned challenge), only
 *     the matching agent is selectable and the dropdown is locked
 *   * POST to /api/owners/me/lobby/accept/[id] with the Privy JWT
 *   * Inline error surface with the server-side reason code
 *   * Redirect to /match/[matchId] on success
 *
 * No tier check here — that runs server-side in the accept route
 * and bubbles up as `tier_insufficient` if the owner wallet doesn't
 * meet the Play tier.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { useWalletState } from "@/components/providers";

interface MyAgent {
  id: string;
  handle: string;
  displayName: string;
  elo: number;
  recalledAt: string | null;
}

interface Props {
  challengeId: string;
  requiredOpponentHandle: string | null;
  stakeUsdc: number | null;
  mode: "free" | "paid" | "system";
}

export function AcceptForm({
  challengeId,
  requiredOpponentHandle,
  stakeUsdc,
  mode,
}: Props) {
  const router = useRouter();
  const walletState = useWalletState();
  const { ready, authenticated, login, getAccessToken } = usePrivy();

  const [myAgents, setMyAgents] = useState<MyAgent[] | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !authenticated) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const t = await getAccessToken();
        if (!t) throw new Error("No Privy access token.");

        // Seed owner row (idempotent), same call the dashboard uses.
        await fetch("/api/owners/me", {
          method: "POST",
          headers: { Authorization: `Bearer ${t}` },
        });

        const res = await fetch("/api/owners/me/agents", {
          headers: { Authorization: `Bearer ${t}` },
        });
        if (!res.ok) throw new Error(`agents lookup failed (${res.status})`);
        const json = (await res.json()) as { agents: MyAgent[] };
        if (cancelled) return;
        setMyAgents(json.agents);

        // Auto-select rules:
        //   * if pinned, pick the matching agent (or none, if the user
        //     doesn't own them)
        //   * else: first non-recalled agent
        const pick = requiredOpponentHandle
          ? json.agents.find((a) => a.handle === requiredOpponentHandle)
          : json.agents.find((a) => !a.recalledAt);
        setSelectedAgentId(pick?.id ?? null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, getAccessToken, requiredOpponentHandle]);

  const eligible = useMemo<MyAgent[]>(() => {
    if (!myAgents) return [];
    if (requiredOpponentHandle) {
      return myAgents.filter((a) => a.handle === requiredOpponentHandle);
    }
    return myAgents.filter((a) => !a.recalledAt);
  }, [myAgents, requiredOpponentHandle]);

  async function submit() {
    if (!selectedAgentId) return;
    setSubmitting(true);
    setError(null);
    try {
      const t = await getAccessToken();
      if (!t) throw new Error("No Privy access token.");
      const res = await fetch(`/api/owners/me/lobby/accept/${challengeId}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${t}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ agentId: selectedAgentId }),
      });
      const body = (await res.json()) as
        | { matchId: string; stateUrl: string }
        | { error: string; message?: string };
      if (!res.ok || !("matchId" in body)) {
        const message =
          "message" in body && body.message
            ? body.message
            : "error" in body
              ? body.error
              : `HTTP ${res.status}`;
        throw new Error(message);
      }
      // Hard navigation so the match page boots cleanly with its
      // own realtime subscription.
      window.location.assign(body.stateUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Privy provider boot / disabled paths ───
  if (walletState === "disabled") {
    return (
      <Notice tone="err">
        Wallet integration is disabled on this deploy. Operator must configure
        Privy before challenges can be accepted from the browser.
      </Notice>
    );
  }
  if (walletState === "loading" || !ready) {
    return <Notice tone="muted">Loading wallet provider…</Notice>;
  }

  if (!authenticated) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Notice tone="muted">
          Sign in with the wallet that owns the agent you want to use.
        </Notice>
        <button type="button" className="btn primary" onClick={() => login()}>
          Sign in to accept
        </button>
      </div>
    );
  }

  if (loading) {
    return <Notice tone="muted">Loading your agents…</Notice>;
  }

  if (myAgents && myAgents.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Notice tone="warn">
          You don&apos;t have any agents registered yet. Register one before
          you can accept challenges.
        </Notice>
        <a className="btn primary" href="/register">
          Register an agent
        </a>
      </div>
    );
  }

  if (requiredOpponentHandle && eligible.length === 0) {
    return (
      <Notice tone="err">
        This challenge is pinned to{" "}
        <code className="mono">@{requiredOpponentHandle}</code> — none of your
        agents match that handle. Switch wallets, or pick a different open
        challenge.
      </Notice>
    );
  }

  if (eligible.length === 0) {
    return (
      <Notice tone="warn">
        All of your agents are currently recalled. Clear a recall from the
        dashboard before accepting.
      </Notice>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--text-mute)",
        }}
      >
        Accept as
      </label>
      <select
        value={selectedAgentId ?? ""}
        onChange={(e) => setSelectedAgentId(e.target.value)}
        className="input"
        style={{ width: "100%" }}
        disabled={eligible.length === 1}
      >
        {eligible.map((a) => (
          <option key={a.id} value={a.id}>
            @{a.handle} — {a.displayName} (ELO {a.elo})
          </option>
        ))}
      </select>

      {error ? (
        <Notice tone="err">{error}</Notice>
      ) : (
        <div style={{ fontSize: 11, color: "var(--text-mute)" }}>
          {mode === "paid" && stakeUsdc
            ? `You'll lock ${(stakeUsdc / 1_000_000).toFixed(stakeUsdc < 1_000_000 ? 3 : 2)} USDC from your wallet on accept. Winner takes 95% of the pot; 5% goes to the treasury.`
            : "Free mode pays an x402 anti-spam fee (~$0.01). No USDC stake."}
        </div>
      )}

      <button
        type="button"
        className="btn primary"
        onClick={submit}
        disabled={!selectedAgentId || submitting}
        style={{ marginTop: 6 }}
      >
        {submitting ? "Accepting…" : "Accept challenge"}
      </button>
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "ok" | "muted" | "warn" | "err";
  children: React.ReactNode;
}) {
  const color =
    tone === "err"
      ? "var(--ox-bright)"
      : tone === "warn"
        ? "var(--gold)"
        : tone === "ok"
          ? "var(--green-text)"
          : "var(--text-mute)";
  return (
    <div
      style={{
        padding: "10px 14px",
        border: "1px solid var(--line)",
        borderRadius: 4,
        background: "var(--bg-2)",
        color,
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}
