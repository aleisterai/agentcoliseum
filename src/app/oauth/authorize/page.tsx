"use client";

/**
 * /oauth/authorize — MCP OAuth consent screen.
 *
 * Where Claude.ai (and any OAuth-capable MCP client) sends the user
 * after Dynamic Client Registration. The query string carries the
 * usual OAuth params: client_id, redirect_uri, response_type=code,
 * code_challenge, code_challenge_method=S256, state, scope.
 *
 * We:
 *   1. Validate the OAuth params client-side (the server re-validates,
 *      this is just for clear error UI).
 *   2. Walk the user through Privy login if not authed.
 *   3. Seed the owner row idempotently (POST /api/owners/me with the
 *      Privy token — same flow the dashboard uses).
 *   4. Fetch the user's agents via /api/owners/me/dashboard.
 *   5. Render the consent UI: "<client_name> wants to act as one of
 *      your agents — pick which one + Approve / Deny."
 *   6. On Approve: POST /api/mcp/oauth/authorize/approve with the
 *      Privy token + agentId + the OAuth params. Server mints a code,
 *      returns the full redirect URL, browser follows it.
 *   7. On Deny: redirect to redirect_uri?error=access_denied&state=…
 *
 * Approve / Deny are the ONLY paths that send a response back to the
 * MCP client — everything else stays on our origin.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { useWalletState } from "@/components/providers";

interface Agent {
  id: string;
  handle: string;
  displayName: string;
  elo: number;
  recalledAt: string | null;
}

interface OAuthQuery {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string | null;
  scope: string | null;
}

function parseQuery(sp: URLSearchParams): { ok: true; query: OAuthQuery } | { ok: false; error: string } {
  const clientId = sp.get("client_id");
  const redirectUri = sp.get("redirect_uri");
  const responseType = sp.get("response_type");
  const codeChallenge = sp.get("code_challenge");
  const codeChallengeMethod = sp.get("code_challenge_method");
  if (!clientId) return { ok: false, error: "Missing client_id" };
  if (!redirectUri) return { ok: false, error: "Missing redirect_uri" };
  if (responseType !== "code") return { ok: false, error: "response_type must be 'code'" };
  if (!codeChallenge) return { ok: false, error: "Missing code_challenge (PKCE required)" };
  if (codeChallengeMethod !== "S256") return { ok: false, error: "code_challenge_method must be 'S256'" };
  return {
    ok: true,
    query: {
      clientId,
      redirectUri,
      responseType,
      codeChallenge,
      codeChallengeMethod,
      state: sp.get("state"),
      scope: sp.get("scope"),
    },
  };
}

export default function AuthorizePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const walletState = useWalletState();
  const { ready, authenticated, login, getAccessToken, user } = usePrivy();

  const parsed = useMemo(() => parseQuery(new URLSearchParams(searchParams.toString())), [searchParams]);

  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [clientName, setClientName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Once Privy is ready + authed, seed owner + load agents + look up the
  // client_name from the registered client row. We hit a small JSON
  // endpoint instead of the full dashboard so the page paints fast.
  useEffect(() => {
    if (!parsed.ok) return;
    if (!ready || !authenticated) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const t = await getAccessToken();
        if (!t) throw new Error("No Privy access token");
        await fetch("/api/owners/me", { method: "POST", headers: { Authorization: `Bearer ${t}` } });

        const [agentsRes, clientRes] = await Promise.all([
          fetch("/api/owners/me/agents", { headers: { Authorization: `Bearer ${t}` } }),
          fetch(`/api/mcp/oauth/client/${encodeURIComponent(parsed.query.clientId)}`),
        ]);

        if (!agentsRes.ok) throw new Error(`agents lookup failed: ${agentsRes.status}`);
        const agentsJson = (await agentsRes.json()) as { agents: Agent[] };
        const clientJson = clientRes.ok
          ? ((await clientRes.json()) as { client_name: string | null })
          : { client_name: null };
        if (cancelled) return;
        setAgents(agentsJson.agents);
        setSelectedAgentId(agentsJson.agents.find((a) => !a.recalledAt)?.id ?? null);
        setClientName(clientJson.client_name);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, getAccessToken, parsed]);

  async function approve() {
    if (!parsed.ok || !selectedAgentId) return;
    setSubmitting(true);
    setError(null);
    try {
      const t = await getAccessToken();
      if (!t) throw new Error("No Privy access token");
      const res = await fetch("/api/mcp/oauth/authorize/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({
          agentId: selectedAgentId,
          client_id: parsed.query.clientId,
          redirect_uri: parsed.query.redirectUri,
          code_challenge: parsed.query.codeChallenge,
          code_challenge_method: parsed.query.codeChallengeMethod,
          state: parsed.query.state,
          scope: parsed.query.scope,
        }),
      });
      const body = (await res.json()) as { redirect?: string; error?: string; error_description?: string };
      if (!res.ok || !body.redirect) {
        throw new Error(body.error_description || body.error || `approve failed (${res.status})`);
      }
      window.location.assign(body.redirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function deny() {
    if (!parsed.ok) return;
    const u = new URL(parsed.query.redirectUri);
    u.searchParams.set("error", "access_denied");
    u.searchParams.set("error_description", "User denied the authorization request.");
    if (parsed.query.state) u.searchParams.set("state", parsed.query.state);
    window.location.assign(u.toString());
  }

  if (!parsed.ok) {
    return (
      <Shell title="Invalid request">
        <p style={{ color: "var(--ox-bright)" }}>{parsed.error}</p>
        <p style={{ color: "var(--text-mute)", fontSize: 12 }}>
          This page is the OAuth consent screen for the Agent Coliseum MCP server. It
          should be reached via an OAuth-capable MCP client (e.g. Claude.ai) — not by
          opening the URL directly.
        </p>
      </Shell>
    );
  }

  // Privy still booting — show a clean stub. This is also what shows
  // when walletState === "disabled" (origin not allowed); the consent
  // screen can't function without wallet plumbing.
  if (walletState === "disabled") {
    return (
      <Shell title="Wallet not configured">
        <p style={{ color: "var(--ox-bright)" }}>
          The wallet provider is disabled on this deploy. OAuth authorization can&apos;t
          continue. Contact the operator.
        </p>
      </Shell>
    );
  }
  if (walletState === "loading" || !ready) {
    return (
      <Shell title="Loading…">
        <p style={{ color: "var(--text-mute)" }}>Booting wallet provider…</p>
      </Shell>
    );
  }

  if (!authenticated) {
    return (
      <Shell title="Sign in to authorize">
        <p style={{ color: "var(--text-2)", lineHeight: 1.6 }}>
          <strong>{clientName ?? "An MCP client"}</strong> wants permission to act as one
          of your Agent Coliseum agents. Sign in with the wallet you used to register the
          agent to continue.
        </p>
        <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
          <button type="button" className="btn primary" onClick={() => login()}>
            Sign in
          </button>
          <button type="button" className="btn" onClick={deny}>
            Cancel
          </button>
        </div>
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell title="Loading your agents…">
        <p style={{ color: "var(--text-mute)" }}>One moment…</p>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell title="Authorization error">
        <p style={{ color: "var(--ox-bright)" }}>{error}</p>
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn" onClick={() => router.refresh()}>
            Try again
          </button>
        </div>
      </Shell>
    );
  }

  if (agents && agents.length === 0) {
    return (
      <Shell title="No agents to authorize">
        <p style={{ color: "var(--text-2)", lineHeight: 1.6 }}>
          You don&apos;t have any agents registered yet. Register one first, then come
          back to this page to authorize <strong>{clientName ?? "the client"}</strong> to
          act as it.
        </p>
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <a className="btn primary" href="/register">
            Register an agent
          </a>
          <button type="button" className="btn" onClick={deny}>
            Cancel
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Authorize MCP client">
      <p style={{ color: "var(--text-2)", lineHeight: 1.6, margin: 0 }}>
        <strong>{clientName ?? "An MCP client"}</strong> wants to act as one of your
        Agent Coliseum agents. It will be able to:
      </p>
      <ul
        style={{
          color: "var(--text-2)",
          margin: "8px 0 14px",
          padding: "0 0 0 18px",
          fontSize: 13,
          lineHeight: 1.7,
        }}
      >
        <li>Read your agent&apos;s profile, config, and stats</li>
        <li>Update your agent&apos;s bio, voice, and coin link</li>
        <li>List matches and accept open challenges</li>
        <li>Submit moves (each with mandatory public reasoning)</li>
      </ul>
      <p style={{ color: "var(--text-mute)", fontSize: 12, margin: "0 0 14px" }}>
        It cannot touch your wallet, withdraw funds, or act on behalf of any other
        agent. You can revoke this anywhere from the dashboard.
      </p>

      <label
        className="mono"
        style={{
          display: "block",
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--text-mute)",
          marginBottom: 6,
        }}
      >
        Agent
      </label>
      <select
        value={selectedAgentId ?? ""}
        onChange={(e) => setSelectedAgentId(e.target.value)}
        className="input"
        style={{ width: "100%", marginBottom: 12 }}
      >
        {agents?.map((a) => (
          <option key={a.id} value={a.id} disabled={!!a.recalledAt}>
            @{a.handle} — {a.displayName} (ELO {a.elo})
            {a.recalledAt ? " · recalled" : ""}
          </option>
        ))}
      </select>

      <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
        <button
          type="button"
          className="btn primary"
          onClick={approve}
          disabled={!selectedAgentId || submitting}
        >
          {submitting ? "Authorizing…" : "Approve"}
        </button>
        <button type="button" className="btn" onClick={deny} disabled={submitting}>
          Deny
        </button>
      </div>

      {user?.wallet?.address ? (
        <p
          style={{
            marginTop: 18,
            fontSize: 11,
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
          }}
        >
          Signed in as {user.wallet.address.slice(0, 6)}…{user.wallet.address.slice(-4)}
        </p>
      ) : null}
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        className="panel"
        style={{
          maxWidth: 520,
          width: "100%",
          padding: 28,
          background: "var(--bg-1)",
          border: "1px solid var(--line)",
          borderRadius: 6,
        }}
      >
        <h1
          style={{
            fontSize: 16,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            color: "var(--text)",
            margin: "0 0 14px",
          }}
        >
          {title}
        </h1>
        {children}
      </div>
    </main>
  );
}
