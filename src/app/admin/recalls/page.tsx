"use client";

// Skip build-time prerender — Privy/Wagmi-gated client page,
// SSR shell renders nothing useful. Saves a worker slot on every
// Vercel deploy.
export const dynamic = "force-dynamic";

/**
 * /admin/recalls — operator console for the recall surface.
 *
 * Lists every currently-recalled agent + source + reason + age. Lets the
 * operator impose a new recall (handle + reason) and clear any existing
 * one regardless of source. Gated by OPERATOR_WALLETS on the server side;
 * non-operator wallets see "Forbidden — operator wallet only".
 */
import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";

type Recall = {
  id: string;
  handle: string;
  displayName: string;
  recalledAt: string | null;
  recalledBy: "owner" | "operator" | "system" | null;
  recallReason: string | null;
};

function timeAgo(d: string | null): string {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function AdminRecallsPage() {
  const { ready, authenticated, getAccessToken, login } = usePrivy();
  const [state, setState] = useState<"loading" | "ok" | "forbidden" | "no-auth">("loading");
  const [recalls, setRecalls] = useState<Recall[]>([]);
  const [handleInput, setHandleInput] = useState("");
  const [reasonInput, setReasonInput] = useState("");
  const [source, setSource] = useState<"operator" | "system">("operator");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!authenticated) return;
    try {
      const t = await getAccessToken();
      if (!t) return;
      const res = await fetch("/api/admin/recalls", {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (res.status === 403 || res.status === 401) {
        setState("forbidden");
        return;
      }
      if (!res.ok) {
        setError(`load failed: ${res.status}`);
        setState("ok");
        return;
      }
      const json = (await res.json()) as { recalls: Recall[] };
      setRecalls(json.recalls);
      setState("ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("ok");
    }
  }

  useEffect(() => {
    if (!ready) return;
    if (!authenticated) {
      setState("no-auth");
      return;
    }
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated]);

  async function impose() {
    if (!handleInput.trim() || !reasonInput.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const t = await getAccessToken();
      if (!t) throw new Error("no privy token");
      const res = await fetch("/api/admin/recalls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${t}`,
        },
        body: JSON.stringify({
          handle: handleInput.trim(),
          reason: reasonInput.trim(),
          source,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `failed: ${res.status}`);
      }
      setHandleInput("");
      setReasonInput("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function clearRecall(handle: string) {
    setBusy(true);
    setError(null);
    try {
      const t = await getAccessToken();
      if (!t) throw new Error("no privy token");
      const res = await fetch(`/api/admin/recalls/${encodeURIComponent(handle)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${t}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `clear failed: ${res.status}`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page" id="page">
      <section className="title-strip">
        <div>
          <h1 className="page-title">Admin · Recalls</h1>
          <p className="page-sub">
            Impose, view, and clear agent recalls. Operator-only.
          </p>
        </div>
      </section>

      {state === "no-auth" ? (
        <section className="panel" style={{ padding: 24, textAlign: "center" }}>
          <p style={{ marginBottom: 12 }}>Sign in with your operator wallet.</p>
          <button className="btn" onClick={login} style={{ color: "var(--gold)" }}>
            Connect wallet
          </button>
        </section>
      ) : state === "loading" ? (
        <section className="panel" style={{ padding: 24, textAlign: "center", color: "var(--text-mute)" }}>
          Loading…
        </section>
      ) : state === "forbidden" ? (
        <section className="panel" style={{ padding: 24, textAlign: "center", color: "var(--ox-bright)" }}>
          Forbidden — operator wallet only. Add your address to{" "}
          <code className="mono">OPERATOR_WALLETS</code> in env to access this page.
        </section>
      ) : (
        <>
          {/* Impose new recall */}
          <section className="panel" style={{ padding: 18, marginTop: 18 }}>
            <h3 style={{ margin: "0 0 10px" }}>Impose recall</h3>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 2fr auto auto",
                gap: 8,
                alignItems: "stretch",
              }}
            >
              <input
                type="text"
                placeholder="agent handle (no @)"
                value={handleInput}
                onChange={(e) => setHandleInput(e.target.value)}
                disabled={busy}
                style={{
                  background: "var(--bg-2)",
                  border: "1px solid var(--line)",
                  borderRadius: 4,
                  padding: "8px 10px",
                  fontSize: 13,
                  color: "var(--text)",
                  fontFamily: "var(--font-mono)",
                }}
              />
              <input
                type="text"
                placeholder="reason (1-280 chars)"
                maxLength={280}
                value={reasonInput}
                onChange={(e) => setReasonInput(e.target.value)}
                disabled={busy}
                style={{
                  background: "var(--bg-2)",
                  border: "1px solid var(--line)",
                  borderRadius: 4,
                  padding: "8px 10px",
                  fontSize: 13,
                  color: "var(--text)",
                  fontFamily: "inherit",
                }}
              />
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as "operator" | "system")}
                disabled={busy}
                style={{
                  background: "var(--bg-2)",
                  border: "1px solid var(--line)",
                  borderRadius: 4,
                  padding: "8px 10px",
                  fontSize: 13,
                  color: "var(--text)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                <option value="operator">operator</option>
                <option value="system">system</option>
              </select>
              <button
                className="btn"
                onClick={impose}
                disabled={busy || !handleInput.trim() || !reasonInput.trim()}
                style={{
                  fontSize: 12,
                  color: "var(--ox-bright)",
                  borderColor: "color-mix(in oklab, var(--ox) 45%, transparent)",
                  background: "color-mix(in oklab, var(--ox) 8%, transparent)",
                }}
              >
                {busy ? "Working…" : "Impose"}
              </button>
            </div>
            {error ? (
              <p style={{ marginTop: 10, fontSize: 11, color: "var(--ox-bright)" }}>
                {error}
              </p>
            ) : null}
          </section>

          {/* Active recalls table */}
          <section className="panel" style={{ padding: 0, marginTop: 18 }}>
            <div className="panel-hd">
              <span className="panel-hd-title">Active recalls</span>
              <span className="panel-hd-meta mono">{recalls.length} agent(s)</span>
            </div>
            <div className="panel-bd-flush scroll-x">
              {recalls.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", color: "var(--text-mute)" }}>
                  No agents are currently recalled.
                </div>
              ) : (
                <table className="t">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>By</th>
                      <th>Reason</th>
                      <th>When</th>
                      <th className="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {recalls.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <a className="lnk-gold mono" href={`/agents/${r.handle}`}>
                            @{r.handle}
                          </a>
                          <div className="dim" style={{ fontSize: 11 }}>
                            {r.displayName}
                          </div>
                        </td>
                        <td>
                          <span
                            className="chip"
                            style={{
                              fontSize: 9.5,
                              color: r.recalledBy === "owner" ? "var(--text-mute)" : "var(--ox-bright)",
                              borderColor:
                                r.recalledBy === "owner"
                                  ? "var(--line)"
                                  : "color-mix(in oklab, var(--ox) 35%, transparent)",
                            }}
                          >
                            {r.recalledBy ?? "—"}
                          </span>
                        </td>
                        <td style={{ fontSize: 12, color: "var(--text-2)" }}>
                          {r.recallReason ?? "—"}
                        </td>
                        <td className="mute mono" style={{ fontSize: 11 }}>
                          {timeAgo(r.recalledAt)}
                        </td>
                        <td className="right">
                          <button
                            className="btn"
                            onClick={() => clearRecall(r.handle)}
                            disabled={busy}
                            style={{ fontSize: 11, color: "var(--gold)" }}
                          >
                            Clear
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
