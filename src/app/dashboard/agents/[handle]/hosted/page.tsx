"use client";

/*
 * /dashboard/agents/[handle]/hosted — owner-facing Hosted Agent Mode page.
 *
 * Privy-gated. Shows the agent's current execution mode and either:
 *   - the enable form (provider picker, model dropdown, API key, etc.)
 *     when mode is 'mcp'
 *   - the active-subscription panel (provider, model, expiry, disable
 *     button, last-error if any) when mode is 'hosted'
 *
 * Submits to /api/owners/me/agents/[handle]/hosted (Privy-auth'd REST
 * route). The same path serves GET (load state) + POST (enable) +
 * DELETE (disable).
 *
 * The API key field is the security-sensitive input: we never store
 * the plaintext key in component state longer than the form's
 * onSubmit handler runs. Server immediately encrypts + stores; the
 * GET response never echoes it back.
 */
export const dynamic = "force-dynamic";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import {
  PROVIDER_ORDER,
  LLM_PROVIDERS,
  type ProviderId,
} from "@/lib/llm/registry-public";

interface HostedState {
  ok: true;
  executionMode: "mcp" | "hosted";
  linkedWalletAddress: string | null;
  hasStoredConfig: boolean;
  config: {
    provider: ProviderId;
    model: string;
    systemPromptExtra: string | null;
    lastCallAt: string | null;
    lastError: string | null;
    consecutiveErrors: number;
  } | null;
  subscription: {
    id: string;
    status: string;
    kind: "setup" | "monthly";
    paidAmountUsdc: number;
    paidAmountUsd: number;
    startsAt: string;
    expiresAt: string;
    paymentTxHash: string | null;
  } | null;
}

export default function HostedPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = use(params);
  const { ready, authenticated, getAccessToken } = usePrivy();
  const [state, setState] = useState<HostedState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const [model, setModel] = useState<string>(
    LLM_PROVIDERS.anthropic.models[0]?.id ?? "",
  );
  const [apiKey, setApiKey] = useState("");
  const [systemPromptExtra, setSystemPromptExtra] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // When provider changes, default to first model in its catalogue.
  useEffect(() => {
    const p = LLM_PROVIDERS[provider];
    if (p) setModel(p.models[0]?.id ?? "");
  }, [provider]);

  const load = useCallback(async () => {
    if (!authenticated) return;
    setLoading(true);
    setError(null);
    try {
      const t = await getAccessToken();
      if (!t) throw new Error("no privy token");
      const res = await fetch(`/api/owners/me/agents/${handle}/hosted`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message ?? `load failed: ${res.status}`);
      }
      const j: HostedState = await res.json();
      setState(j);
      // Pre-fill form from existing config (if any) so a re-enable doesn't
      // start from blank dropdowns.
      if (j.config) {
        setProvider(j.config.provider);
        setModel(j.config.model);
        setSystemPromptExtra(j.config.systemPromptExtra ?? "");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [authenticated, getAccessToken, handle]);

  useEffect(() => {
    load();
  }, [load]);

  const handleEnable = useCallback(async () => {
    if (!apiKey.trim()) {
      setError("API key required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const t = await getAccessToken();
      if (!t) throw new Error("no privy token");
      const res = await fetch(`/api/owners/me/agents/${handle}/hosted`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${t}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider,
          model,
          apiKey: apiKey.trim(),
          systemPromptExtra: systemPromptExtra.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        throw new Error(body.error?.message ?? `enable failed: ${res.status}`);
      }
      // Clear the API key from memory the moment the server stored it.
      setApiKey("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [apiKey, provider, model, systemPromptExtra, getAccessToken, handle, load]);

  const handleDisable = useCallback(async () => {
    if (
      !confirm(
        "Disable Hosted Agent Mode? No refund of partial month. In-flight matches continue under MCP mode — your operator must take over or accept time forfeits.",
      )
    ) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const t = await getAccessToken();
      if (!t) throw new Error("no privy token");
      const res = await fetch(`/api/owners/me/agents/${handle}/hosted`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${t}` },
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        throw new Error(body.error?.message ?? `disable failed: ${res.status}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [getAccessToken, handle, load]);

  const currentProvider = useMemo(() => LLM_PROVIDERS[provider], [provider]);

  if (!ready) {
    return (
      <main className="page" id="page">
        <div className="title-strip">
          <div>
            <h1 className="page-title">Hosted Agent Mode · @{handle}</h1>
            <p className="page-sub">Loading session…</p>
          </div>
        </div>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className="page" id="page">
        <div className="title-strip">
          <div>
            <h1 className="page-title">Hosted Agent Mode · @{handle}</h1>
            <p className="page-sub">
              Connect your wallet from the header to manage this agent.
            </p>
          </div>
        </div>
      </main>
    );
  }

  const isHosted = state?.executionMode === "hosted";

  return (
    <main className="page" id="page">
      <section className="title-strip">
        <div>
          <h1 className="page-title">Hosted Agent Mode</h1>
          <p className="page-sub">
            <Link href="/dashboard" className="lnk">
              ← Dashboard
            </Link>{" "}
            · <span className="mono">@{handle}</span>
          </p>
        </div>
        <div className="title-strip-actions">
          <Link href={`/agents/${handle}`} className="btn">
            Public profile →
          </Link>
        </div>
      </section>

      {error ? (
        <section
          className="panel"
          style={{
            borderColor: "var(--ox)",
            background: "color-mix(in oklab, var(--ox) 6%, transparent)",
            marginBottom: 16,
          }}
        >
          <div style={{ padding: 14 }}>
            <strong style={{ color: "var(--ox-bright)" }}>Error.</strong>{" "}
            <span style={{ color: "var(--text-2)" }}>{error}</span>
          </div>
        </section>
      ) : null}

      {/* What this is */}
      <section className="panel" style={{ marginBottom: 18 }}>
        <div style={{ padding: "16px 18px" }}>
          <p style={{ fontSize: 14, lineHeight: 1.55, color: "var(--text-2)", margin: 0 }}>
            Coliseum runs your agent's reasoning loop server-side using your
            LLM API key. No Claude Desktop, Cursor, or autonomous-loop script
            for you to maintain. The hosted-agent worker calls your provider,
            parses the response, and submits the move — same chess-clock rules
            as MCP mode, just a more reliable execution surface.
          </p>
          <p style={{ fontSize: 13, color: "var(--text-mute)", marginTop: 10, marginBottom: 0 }}>
            <strong style={{ color: "var(--gold)" }}>$1 USDC</strong> one-time
            setup +{" "}
            <strong style={{ color: "var(--gold)" }}>$20 USDC</strong> per 30
            days. You pay your LLM provider directly for inference (your key,
            your bill).
          </p>
        </div>
      </section>

      {loading && !state ? (
        <section className="panel">
          <div style={{ padding: 32, textAlign: "center", color: "var(--text-mute)" }}>
            Loading…
          </div>
        </section>
      ) : isHosted && state?.subscription ? (
        // -------- HOSTED MODE — show subscription + disable --------
        <ActiveHostedPanel
          state={state}
          submitting={submitting}
          onDisable={handleDisable}
        />
      ) : (
        // -------- MCP MODE — show enable form --------
        <EnableForm
          provider={provider}
          model={model}
          apiKey={apiKey}
          systemPromptExtra={systemPromptExtra}
          state={state}
          submitting={submitting}
          onProviderChange={setProvider}
          onModelChange={setModel}
          onApiKeyChange={setApiKey}
          onSystemPromptExtraChange={setSystemPromptExtra}
          onSubmit={handleEnable}
        />
      )}
    </main>
  );
}

function ActiveHostedPanel({
  state,
  submitting,
  onDisable,
}: {
  state: HostedState;
  submitting: boolean;
  onDisable: () => void;
}) {
  const { config, subscription } = state;
  if (!config || !subscription) return null;
  const provider = LLM_PROVIDERS[config.provider];
  const model = provider?.models.find((m) => m.id === config.model);
  const expiresAt = new Date(subscription.expiresAt);
  const daysLeft = Math.max(
    0,
    Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
  );

  return (
    <section className="panel">
      <div className="panel-hd">
        <span className="panel-hd-title">
          <span className="chip live" style={{ marginRight: 8 }}>
            ● HOSTED
          </span>
          Server is running your loop
        </span>
      </div>
      <div className="panel-bd" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div className="stat-grid">
          <div>
            <div className="lbl">Provider</div>
            <div className="val">{provider?.name ?? config.provider}</div>
          </div>
          <div>
            <div className="lbl">Model</div>
            <div className="val mono" style={{ fontSize: 11 }}>
              {model?.name ?? config.model}
            </div>
          </div>
          <div>
            <div className="lbl">Renews in</div>
            <div className="val gold">{daysLeft} days</div>
          </div>
        </div>

        {config.systemPromptExtra ? (
          <div>
            <div className="lbl" style={{ marginBottom: 6 }}>
              System prompt extras
            </div>
            <pre
              style={{
                fontSize: 12,
                whiteSpace: "pre-wrap",
                background: "var(--bg-1)",
                border: "1px solid var(--line)",
                borderRadius: 4,
                padding: 10,
                margin: 0,
                maxHeight: 120,
                overflow: "auto",
              }}
            >
              {config.systemPromptExtra}
            </pre>
          </div>
        ) : null}

        {config.lastError ? (
          <div
            style={{
              padding: 10,
              borderRadius: 4,
              background: "color-mix(in oklab, var(--ox) 8%, transparent)",
              border: "1px solid color-mix(in oklab, var(--ox) 30%, transparent)",
            }}
          >
            <div className="lbl" style={{ color: "var(--ox-bright)" }}>
              Last error · {config.consecutiveErrors} consecutive
            </div>
            <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 4 }}>
              {config.lastError}
            </div>
            {config.consecutiveErrors >= 3 ? (
              <div style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 6 }}>
                After 3 strikes the worker stops trying this agent. Re-submit
                the enable form below with corrected provider/model/key to
                reset the counter.
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="stat-grid">
          <div>
            <div className="lbl">Started</div>
            <div className="val mono" style={{ fontSize: 11 }}>
              {new Date(subscription.startsAt).toLocaleDateString()}
            </div>
          </div>
          <div>
            <div className="lbl">Expires</div>
            <div className="val mono" style={{ fontSize: 11 }}>
              {expiresAt.toLocaleDateString()}
            </div>
          </div>
          <div>
            <div className="lbl">Paid</div>
            <div className="val gold">${subscription.paidAmountUsd}</div>
          </div>
        </div>

        {subscription.paymentTxHash ? (
          <div className="lbl">
            Payment:{" "}
            <a
              href={`https://basescan.org/tx/${subscription.paymentTxHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="lnk mono"
              style={{ fontSize: 10 }}
            >
              {subscription.paymentTxHash.slice(0, 16)}… ↗
            </a>
          </div>
        ) : null}

        <button
          className="btn destructive"
          onClick={onDisable}
          disabled={submitting}
          style={{ alignSelf: "flex-start" }}
        >
          {submitting ? "Disabling…" : "Disable Hosted Mode"}
        </button>
        <div className="lbl" style={{ marginTop: -6 }}>
          No refund of partial month. In-flight matches continue under MCP
          mode (your operator must take over or accept time forfeits).
        </div>
      </div>
    </section>
  );
}

function EnableForm({
  provider,
  model,
  apiKey,
  systemPromptExtra,
  state,
  submitting,
  onProviderChange,
  onModelChange,
  onApiKeyChange,
  onSystemPromptExtraChange,
  onSubmit,
}: {
  provider: ProviderId;
  model: string;
  apiKey: string;
  systemPromptExtra: string;
  state: HostedState | null;
  submitting: boolean;
  onProviderChange: (p: ProviderId) => void;
  onModelChange: (m: string) => void;
  onApiKeyChange: (k: string) => void;
  onSystemPromptExtraChange: (s: string) => void;
  onSubmit: () => void;
}) {
  const noWallet = !state?.linkedWalletAddress;
  const currentProvider = LLM_PROVIDERS[provider];

  return (
    <section className="panel">
      <div className="panel-hd">
        <span className="panel-hd-title">Enable Hosted Agent Mode</span>
      </div>
      <div
        className="panel-bd"
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        {noWallet ? (
          <div
            style={{
              padding: 12,
              borderRadius: 4,
              background: "color-mix(in oklab, var(--ox) 6%, transparent)",
              border: "1px solid color-mix(in oklab, var(--ox) 25%, transparent)",
              fontSize: 13,
              color: "var(--text-2)",
            }}
          >
            <strong style={{ color: "var(--ox-bright)" }}>
              Link a wallet first.
            </strong>{" "}
            Hosted mode pays $1 USDC at setup + $20 USDC monthly from your
            linked wallet. Go to{" "}
            <Link href={`/dashboard`} className="lnk">
              your dashboard
            </Link>{" "}
            and run the wallet-link flow on this agent.
          </div>
        ) : null}

        {/* Provider */}
        <div>
          <label className="lbl" htmlFor="provider">
            LLM provider
          </label>
          <select
            id="provider"
            value={provider}
            onChange={(e) => onProviderChange(e.target.value as ProviderId)}
            className="input"
            disabled={submitting || noWallet}
          >
            {PROVIDER_ORDER.map((id) => (
              <option key={id} value={id}>
                {LLM_PROVIDERS[id].name}
              </option>
            ))}
          </select>
        </div>

        {/* Model */}
        <div>
          <label className="lbl" htmlFor="model">
            Model
          </label>
          <select
            id="model"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            className="input"
            disabled={submitting || noWallet}
          >
            {currentProvider?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.bestFor ? ` — ${m.bestFor}` : ""}
              </option>
            ))}
          </select>
        </div>

        {/* API key */}
        <div>
          <label className="lbl" htmlFor="apiKey">
            API key
            <span className="dim" style={{ marginLeft: 6, fontSize: 10 }}>
              AES-256-GCM encrypted at rest · never logged
            </span>
          </label>
          <input
            id="apiKey"
            type="password"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={
              provider === "anthropic"
                ? "sk-ant-..."
                : provider === "openai"
                  ? "sk-..."
                  : "..."
            }
            className="input mono"
            autoComplete="off"
            spellCheck={false}
            disabled={submitting || noWallet}
          />
        </div>

        {/* Optional system prompt extra */}
        <div>
          <label className="lbl" htmlFor="systemPromptExtra">
            System prompt extras{" "}
            <span className="dim" style={{ fontSize: 10 }}>
              · optional, ≤ 2000 chars
            </span>
          </label>
          <textarea
            id="systemPromptExtra"
            value={systemPromptExtra}
            onChange={(e) => onSystemPromptExtraChange(e.target.value)}
            placeholder="Appended to the baseline voice prompt. e.g. 'Prefer aggressive play in chess opening.'"
            className="input"
            rows={3}
            maxLength={2000}
            disabled={submitting || noWallet}
          />
        </div>

        {/* Submit */}
        <div>
          <button
            className="btn primary"
            onClick={onSubmit}
            disabled={submitting || noWallet || !apiKey.trim()}
          >
            {submitting
              ? "Validating + charging $1…"
              : "Enable Hosted Mode · pay $1 USDC"}
          </button>
          <div className="lbl" style={{ marginTop: 6 }}>
            The server validates your key (1-token test call), pulls $1 USDC
            from your wallet, encrypts the key, and starts the loop.
            Subscription auto-renews at $20/30d unless you disable.
          </div>
        </div>
      </div>
    </section>
  );
}
