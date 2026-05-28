"use client";

// Skip build-time prerender — Privy/Wagmi-gated client page,
// SSR shell renders nothing useful. Saves a worker slot on every
// Vercel deploy.
export const dynamic = "force-dynamic";

/**
 * /admin/treasury — operator console.
 *
 * Lives at /admin/treasury and renders:
 *   - operator wallet USDC + ETH balance (live, with Basescan link)
 *   - pending liability total (pending payouts + pending refunds in USDC)
 *   - pending-payouts table (queued for settlement-sweep)
 *   - pending-refunds table (queued for refund-expired-challenges)
 *   - treasury_flows history (5% skim flow)
 *   - "Force run" buttons for the two relevant crons
 */
import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";

type TreasuryPayload = {
  operatorAddress: string;
  usdcBalanceMicro: number;
  ethBalanceWei: string;
  basescanUrl: string;
  pendingPayouts: Array<{
    id: string;
    gameType: string;
    potUsdc: number | null;
    winnerAgentId: string | null;
    completedAt: string | null;
  }>;
  pendingRefunds: Array<{
    id: string;
    gameType: string;
    stakeUsdc: number | null;
    proposerStakeTxHash: string | null;
    expiresAt: string | null;
  }>;
  pendingLiabilityUsdc: number;
  treasuryFlows: Array<{
    id: string;
    matchId: string | null;
    feeUsdc: number;
    status: string;
    aleisterOut: string | null;
    swapTxHash: string | null;
    treasuryTxHash: string | null;
    createdAt: string;
    sentAt: string | null;
  }>;
};

function fmtUsdc(microUsdc: number | null | undefined): string {
  if (!microUsdc) return "0.00";
  return (microUsdc / 1_000_000).toFixed(2);
}

function fmtEth(wei: string): string {
  try {
    const n = BigInt(wei);
    const eth = Number(n) / 1e18;
    return eth.toFixed(4);
  } catch {
    return "0.0000";
  }
}

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

export default function AdminTreasuryPage() {
  const { ready, authenticated, getAccessToken, login } = usePrivy();
  const [state, setState] = useState<"loading" | "ok" | "forbidden" | "no-auth">(
    "loading",
  );
  const [data, setData] = useState<TreasuryPayload | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // which action is running
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);

  async function refresh() {
    if (!authenticated) return;
    try {
      const t = await getAccessToken();
      if (!t) return;
      const res = await fetch("/api/admin/treasury", {
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
      setData(await res.json());
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

  async function runAction(action: "settlement-sweep" | "refund-expired-challenges") {
    setBusy(action);
    setError(null);
    try {
      const t = await getAccessToken();
      if (!t) throw new Error("no privy token");
      const res = await fetch("/api/admin/treasury", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${t}`,
        },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`run failed: ${res.status}`);
      const body = (await res.json()) as { status: number; body: unknown };
      setLastRun(`${action} → status ${body.status}: ${JSON.stringify(body.body).slice(0, 300)}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="page" id="page">
      <section className="title-strip">
        <div>
          <h1 className="page-title">Admin · Treasury</h1>
          <p className="page-sub">
            Operator wallet, liabilities, and treasury flows.
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
          Forbidden — operator wallet only.
        </section>
      ) : !data ? null : (
        <>
          {/* KPIs */}
          <section className="dash-kpis" style={{ marginTop: 18 }}>
            <Kpi
              label="USDC balance"
              value={`◆ ${fmtUsdc(data.usdcBalanceMicro)}`}
              sub="operator wallet"
              gold
            />
            <Kpi label="ETH balance" value={fmtEth(data.ethBalanceWei)} sub="for gas" />
            <Kpi
              label="Pending liability"
              value={`◆ ${fmtUsdc(data.pendingLiabilityUsdc)}`}
              sub={`${data.pendingPayouts.length} payouts · ${data.pendingRefunds.length} refunds`}
              gold
            />
            <Kpi
              label="Operator address"
              value={`${data.operatorAddress.slice(0, 6)}…${data.operatorAddress.slice(-4)}`}
              sub={
                <a href={data.basescanUrl} target="_blank" rel="noopener noreferrer" className="lnk-gold mono">
                  Basescan ↗
                </a>
              }
            />
          </section>

          {/* Force-run buttons */}
          <section className="panel" style={{ padding: 18, marginTop: 18 }}>
            <h3 style={{ margin: "0 0 10px" }}>Force-run crons</h3>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className="btn"
                onClick={() => runAction("settlement-sweep")}
                disabled={busy != null}
                style={{ fontSize: 12, color: "var(--gold)" }}
              >
                {busy === "settlement-sweep" ? "Running…" : "Run settlement-sweep"}
              </button>
              <button
                className="btn"
                onClick={() => runAction("refund-expired-challenges")}
                disabled={busy != null}
                style={{ fontSize: 12, color: "var(--gold)" }}
              >
                {busy === "refund-expired-challenges" ? "Running…" : "Run refund-expired-challenges"}
              </button>
              <button
                className="btn"
                onClick={refresh}
                disabled={busy != null}
                style={{ fontSize: 12 }}
              >
                Refresh
              </button>
            </div>
            {lastRun ? (
              <p
                className="mono"
                style={{ marginTop: 10, fontSize: 11, color: "var(--text-mute)" }}
              >
                {lastRun}
              </p>
            ) : null}
            {error ? (
              <p style={{ marginTop: 10, fontSize: 11, color: "var(--ox-bright)" }}>
                {error}
              </p>
            ) : null}
          </section>

          {/* Pending payouts */}
          <section className="panel" style={{ padding: 0, marginTop: 18 }}>
            <div className="panel-hd">
              <span className="panel-hd-title">Pending payouts</span>
              <span className="panel-hd-meta mono">
                {data.pendingPayouts.length} match(es) · {fmtUsdc(data.pendingPayouts.reduce((a, m) => a + (m.potUsdc ?? 0), 0))} USDC
              </span>
            </div>
            <div className="panel-bd-flush scroll-x">
              {data.pendingPayouts.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", color: "var(--text-mute)" }}>
                  Nothing pending.
                </div>
              ) : (
                <table className="t">
                  <thead>
                    <tr>
                      <th>Match</th>
                      <th>Game</th>
                      <th className="right">Pot</th>
                      <th>Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pendingPayouts.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <a className="lnk mono" href={`/match/${m.id}`}>
                            {m.id.slice(0, 8)}…
                          </a>
                        </td>
                        <td>{m.gameType}</td>
                        <td className="right gold mono">
                          ◆ {fmtUsdc(m.potUsdc)}
                        </td>
                        <td className="mute mono" style={{ fontSize: 11 }}>
                          {timeAgo(m.completedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          {/* Pending refunds */}
          <section className="panel" style={{ padding: 0, marginTop: 18 }}>
            <div className="panel-hd">
              <span className="panel-hd-title">Pending refunds</span>
              <span className="panel-hd-meta mono">
                {data.pendingRefunds.length} challenge(s) · {fmtUsdc(data.pendingRefunds.reduce((a, c) => a + (c.stakeUsdc ?? 0), 0))} USDC
              </span>
            </div>
            <div className="panel-bd-flush scroll-x">
              {data.pendingRefunds.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", color: "var(--text-mute)" }}>
                  Nothing pending.
                </div>
              ) : (
                <table className="t">
                  <thead>
                    <tr>
                      <th>Challenge</th>
                      <th>Game</th>
                      <th className="right">Stake</th>
                      <th>Expired</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pendingRefunds.map((c) => (
                      <tr key={c.id}>
                        <td className="mono" style={{ fontSize: 11 }}>
                          {c.id.slice(0, 8)}…
                        </td>
                        <td>{c.gameType}</td>
                        <td className="right gold mono">
                          ◆ {fmtUsdc(c.stakeUsdc)}
                        </td>
                        <td className="mute mono" style={{ fontSize: 11 }}>
                          {timeAgo(c.expiresAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          {/* Treasury flows */}
          <section className="panel" style={{ padding: 0, marginTop: 18 }}>
            <div className="panel-hd">
              <span className="panel-hd-title">Treasury flows</span>
              <span className="panel-hd-meta mono">{data.treasuryFlows.length} recent</span>
            </div>
            <div className="panel-bd-flush scroll-x">
              {data.treasuryFlows.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", color: "var(--text-mute)" }}>
                  No treasury flows yet.
                </div>
              ) : (
                <table className="t">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Status</th>
                      <th className="right">Fee</th>
                      <th>Swap tx</th>
                      <th>Treasury tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.treasuryFlows.map((f) => (
                      <tr key={f.id}>
                        <td className="mute mono" style={{ fontSize: 11 }}>
                          {timeAgo(f.createdAt)}
                        </td>
                        <td>
                          <span
                            className="chip"
                            style={{
                              fontSize: 9.5,
                              color: f.status === "sent" ? "var(--green-text)" : "var(--text-mute)",
                            }}
                          >
                            {f.status}
                          </span>
                        </td>
                        <td className="right gold mono">◆ {fmtUsdc(f.feeUsdc)}</td>
                        <td>
                          {f.swapTxHash ? (
                            <a
                              className="lnk mono"
                              href={`https://basescan.org/tx/${f.swapTxHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ fontSize: 11 }}
                            >
                              {f.swapTxHash.slice(0, 8)}…
                            </a>
                          ) : (
                            <span className="mute mono" style={{ fontSize: 11 }}>
                              —
                            </span>
                          )}
                        </td>
                        <td>
                          {f.treasuryTxHash ? (
                            <a
                              className="lnk mono"
                              href={`https://basescan.org/tx/${f.treasuryTxHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ fontSize: 11 }}
                            >
                              {f.treasuryTxHash.slice(0, 8)}…
                            </a>
                          ) : (
                            <span className="mute mono" style={{ fontSize: 11 }}>
                              —
                            </span>
                          )}
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

function Kpi({
  label,
  value,
  sub,
  gold,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  gold?: boolean;
}) {
  return (
    <div className="kpi">
      <div className="kpi-lbl">{label}</div>
      <div className={`kpi-val${gold ? " gold" : ""}`}>{value}</div>
      {sub ? <div className="kpi-sub">{sub}</div> : null}
    </div>
  );
}
