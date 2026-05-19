"use client";

/**
 * /admin/health — operator-facing platform diagnostic.
 *
 * Polls /api/admin/health every 10s. Surfaces:
 *   - DB probe latency + pool utilization
 *   - Operator wallet balances
 *   - Pending-work counters (payouts, refunds, active matches, open
 *     challenges, running tournaments)
 *   - Cron freshness — derived from the latest row each cron touches.
 *     If a freshness timestamp goes stale (>5 min), badge it red.
 */
import { useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";

type HealthPayload = {
  timestamp: string;
  operator: {
    address: string;
    usdcBalanceMicro: number;
    ethBalanceWei: string;
  };
  db: {
    ok: boolean;
    probeLatencyMs?: number;
    pool: {
      total: number | null;
      idle: number | null;
      reserved: number | null;
      waiting: number | null;
    };
    sizeBytes: number;
  };
  pending: {
    payouts: number;
    refunds: number;
    activeMatches: number;
    runningTournaments: number;
    openChallenges: number;
  };
  totals: {
    agents: number;
    matches: number;
    matchesActive: number;
    treasuryFlows: number;
  };
  cronRuns: Array<{
    id: string;
    name: string;
    startedAt: string;
    completedAt: string | null;
    ok: boolean | null;
    error: string | null;
    itemsProcessed: number;
    durationMs: number | null;
    metadata: Record<string, unknown> | null;
  }>;
  cronSummary: Record<
    string,
    {
      lastStartedAt: string | null;
      lastCompletedAt: string | null;
      lastOk: boolean | null;
      lastDurationMs: number | null;
      lastError: string | null;
      lastItemsProcessed: number;
      okCount: number;
      failCount: number;
      observedRuns: number;
    }
  >;
};

const KNOWN_CRONS = [
  { name: "settlement-sweep", cadence: "* * * * * (every minute)" },
  { name: "refund-expired-challenges", cadence: "* * * * * (every minute)" },
  { name: "tournament-progression", cadence: "* * * * * (every minute)" },
  { name: "timeout-games", cadence: "* * * * * (every minute)" },
] as const;

function fmtUsdc(microUsdc: number): string {
  return (microUsdc / 1_000_000).toFixed(2);
}

function fmtEth(wei: string): string {
  try {
    const n = BigInt(wei);
    return (Number(n) / 1e18).toFixed(4);
  } catch {
    return "0.0000";
  }
}

function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}

function timeAgo(d: string | null): string {
  if (!d) return "never";
  const ms = Date.now() - new Date(d).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function cronColor(d: string | null, expectedEverySec: number): string {
  // Cron should run every minute. We get worried at 5x expected.
  if (!d) return "var(--text-mute)";
  const ageSec = (Date.now() - new Date(d).getTime()) / 1000;
  // The freshness signal is "last time it produced output". If no payouts/
  // refunds/etc are due, the cron runs but doesn't move data. So an
  // "old" timestamp here can just mean "nothing to do" — color amber
  // not red unless it's REALLY old.
  if (ageSec < expectedEverySec * 60) return "var(--green-text)"; // < 1h normal
  if (ageSec < expectedEverySec * 60 * 24) return "var(--gold)"; // < 24h amber
  return "var(--ox-bright)"; // > 24h red
}

export default function AdminHealthPage() {
  const { ready, authenticated, getAccessToken, login } = usePrivy();
  const [state, setState] = useState<"loading" | "ok" | "forbidden" | "no-auth">("loading");
  const [data, setData] = useState<HealthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    if (!authenticated) {
      setState("no-auth");
      return;
    }
    let cancelled = false;
    async function refresh() {
      try {
        const t = await getAccessToken();
        if (!t) return;
        const res = await fetch("/api/admin/health", {
          headers: { Authorization: `Bearer ${t}` },
        });
        if (cancelled) return;
        if (res.status === 403 || res.status === 401) {
          setState("forbidden");
          return;
        }
        if (!res.ok) {
          setError(`load failed: ${res.status}`);
          return;
        }
        const json = (await res.json()) as HealthPayload;
        setData(json);
        setState("ok");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [ready, authenticated, getAccessToken]);

  const poolUtilization = useMemo(() => {
    if (!data?.db.pool.total) return null;
    const inUse = (data.db.pool.total ?? 0) - (data.db.pool.idle ?? 0);
    return { inUse, total: data.db.pool.total, pct: data.db.pool.total ? (inUse / data.db.pool.total) * 100 : 0 };
  }, [data]);

  return (
    <main className="page" id="page">
      <section className="title-strip">
        <div>
          <h1 className="page-title">Admin · Health</h1>
          <p className="page-sub">
            Live platform diagnostic. Polls every 10s. Operator-only.
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
          {/* Top: probe status */}
          <section className="dash-kpis" style={{ marginTop: 18 }}>
            <Kpi
              label="DB probe"
              value={data.db.ok ? "● OK" : "▲ DOWN"}
              sub={data.db.probeLatencyMs ? `${data.db.probeLatencyMs} ms` : "—"}
              accent={data.db.ok ? "green" : "red"}
            />
            <Kpi
              label="Pool · in use"
              value={poolUtilization ? `${poolUtilization.inUse} / ${poolUtilization.total}` : "—"}
              sub={
                poolUtilization
                  ? `${Math.round(poolUtilization.pct)}% utilization · ${data.db.pool.waiting ?? 0} waiting`
                  : "stats unavailable"
              }
              accent={
                poolUtilization && poolUtilization.pct > 80
                  ? "red"
                  : poolUtilization && poolUtilization.pct > 50
                    ? "amber"
                    : "green"
              }
            />
            <Kpi
              label="DB size"
              value={fmtBytes(data.db.sizeBytes)}
              sub={`${data.totals.matches} matches · ${data.totals.agents} agents`}
            />
            <Kpi
              label="Updated"
              value={timeAgo(data.timestamp)}
              sub="auto-refreshes every 10s"
            />
          </section>

          {/* Operator wallet */}
          <section className="dash-kpis" style={{ marginTop: 18 }}>
            <Kpi
              label="Operator · USDC"
              value={`◆ ${fmtUsdc(data.operator.usdcBalanceMicro)}`}
              sub={
                <a
                  className="lnk-gold mono"
                  href={`https://basescan.org/address/${data.operator.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 11 }}
                >
                  {data.operator.address.slice(0, 6)}…{data.operator.address.slice(-4)} ↗
                </a>
              }
              accent="gold"
            />
            <Kpi
              label="Operator · ETH (gas)"
              value={fmtEth(data.operator.ethBalanceWei)}
              sub={
                Number(fmtEth(data.operator.ethBalanceWei)) < 0.005
                  ? "▲ LOW — top up to keep payouts flowing"
                  : "for tx fees"
              }
              accent={Number(fmtEth(data.operator.ethBalanceWei)) < 0.005 ? "red" : undefined}
            />
            <Kpi
              label="Active matches"
              value={String(data.pending.activeMatches)}
              sub="live agent-vs-agent"
              accent="green"
            />
            <Kpi
              label="Running tournaments"
              value={String(data.pending.runningTournaments)}
              sub={`${data.pending.openChallenges} open challenges`}
            />
          </section>

          {/* Pending work */}
          <section className="panel" style={{ padding: 18, marginTop: 18 }}>
            <h3 style={{ margin: "0 0 10px" }}>Pending work · cron queues</h3>
            <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>
              These counts are what the crons are responsible for draining. Persistent non-zero values mean a cron is stuck — check the freshness timestamps below + the operator wallet ETH balance.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
              <PendingRow
                label="Pending payouts"
                count={data.pending.payouts}
                detail="settlement-sweep queues winners after match completion"
              />
              <PendingRow
                label="Pending refunds"
                count={data.pending.refunds}
                detail="refund-expired-challenges returns stakes when nobody accepted"
              />
            </div>
          </section>

          {/* Cron summary — one row per known cron */}
          <section className="panel" style={{ padding: 0, marginTop: 18 }}>
            <div className="panel-hd">
              <span className="panel-hd-title">Cron summary</span>
              <span className="panel-hd-meta mono">audit log via recordCronRun</span>
            </div>
            <div className="panel-bd-flush scroll-x">
              <table className="t">
                <thead>
                  <tr>
                    <th>Cron</th>
                    <th>Schedule</th>
                    <th>Last run</th>
                    <th className="right">Duration</th>
                    <th className="right">Items</th>
                    <th className="right">OK / Fail (last 50)</th>
                  </tr>
                </thead>
                <tbody>
                  {KNOWN_CRONS.map((c) => {
                    const s = data.cronSummary[c.name];
                    return (
                      <tr key={c.name}>
                        <td className="mono" style={{ fontSize: 12 }}>{c.name}</td>
                        <td className="mono dim" style={{ fontSize: 11 }}>{c.cadence}</td>
                        <td
                          style={{
                            color:
                              s?.lastOk === true
                                ? "var(--green-text)"
                                : s?.lastOk === false
                                  ? "var(--ox-bright)"
                                  : "var(--text-mute)",
                            fontSize: 12,
                          }}
                        >
                          {s ? timeAgo(s.lastStartedAt) : "never observed"}
                          {s?.lastOk === false ? " · failed" : ""}
                        </td>
                        <td className="right mono" style={{ fontSize: 11 }}>
                          {s?.lastDurationMs != null ? `${s.lastDurationMs}ms` : "—"}
                        </td>
                        <td className="right mono" style={{ fontSize: 11 }}>
                          {s?.lastItemsProcessed ?? "—"}
                        </td>
                        <td className="right mono" style={{ fontSize: 11 }}>
                          {s
                            ? `${s.okCount} / ${s.failCount}${s.observedRuns ? ` (${s.observedRuns})` : ""}`
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Recent cron-run timeline */}
          <section className="panel" style={{ padding: 0, marginTop: 18 }}>
            <div className="panel-hd">
              <span className="panel-hd-title">Recent cron runs</span>
              <span className="panel-hd-meta mono">last 50 across all crons</span>
            </div>
            <div className="panel-bd-flush scroll-x">
              {data.cronRuns.length === 0 ? (
                <div style={{ padding: 20, textAlign: "center", color: "var(--text-mute)" }}>
                  No runs yet — the audit log starts populating on the next tick.
                </div>
              ) : (
                <table className="t">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Cron</th>
                      <th>Result</th>
                      <th className="right">Duration</th>
                      <th className="right">Items</th>
                      <th>Detail / error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.cronRuns.map((r) => (
                      <tr key={r.id}>
                        <td className="mute mono" style={{ fontSize: 11 }}>
                          {timeAgo(r.startedAt)}
                        </td>
                        <td className="mono" style={{ fontSize: 11 }}>{r.name}</td>
                        <td>
                          <span
                            className="chip"
                            style={{
                              fontSize: 9.5,
                              color:
                                r.ok === true
                                  ? "var(--green-text)"
                                  : r.ok === false
                                    ? "var(--ox-bright)"
                                    : "var(--text-mute)",
                              borderColor:
                                r.ok === false
                                  ? "color-mix(in oklab, var(--ox) 35%, transparent)"
                                  : "var(--line)",
                            }}
                          >
                            {r.ok === true ? "ok" : r.ok === false ? "fail" : "in-flight"}
                          </span>
                        </td>
                        <td className="right mono" style={{ fontSize: 11 }}>
                          {r.durationMs != null ? `${r.durationMs}ms` : "—"}
                        </td>
                        <td className="right mono" style={{ fontSize: 11 }}>
                          {r.itemsProcessed}
                        </td>
                        <td style={{ fontSize: 11, color: r.error ? "var(--ox-bright)" : "var(--text-mute)" }}>
                          {r.error ?? (r.metadata ? JSON.stringify(r.metadata) : "")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          {error ? (
            <p style={{ marginTop: 10, fontSize: 11, color: "var(--ox-bright)" }}>{error}</p>
          ) : null}
        </>
      )}
    </main>
  );
}

function Kpi({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  accent?: "green" | "amber" | "red" | "gold";
}) {
  const color =
    accent === "green"
      ? "var(--green-text)"
      : accent === "amber"
        ? "var(--gold)"
        : accent === "red"
          ? "var(--ox-bright)"
          : accent === "gold"
            ? "var(--gold)"
            : undefined;
  return (
    <div className="kpi">
      <div className="kpi-lbl">{label}</div>
      <div className="kpi-val" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub ? <div className="kpi-sub">{sub}</div> : null}
    </div>
  );
}

function PendingRow({
  label,
  count,
  detail,
}: {
  label: string;
  count: number;
  detail: string;
}) {
  const color = count === 0 ? "var(--text-mute)" : count > 10 ? "var(--ox-bright)" : "var(--gold)";
  return (
    <div
      style={{
        padding: 12,
        background: "var(--bg-2)",
        border: "1px solid var(--line)",
        borderRadius: 4,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 12, color: "var(--text-2)" }}>{label}</span>
        <span className="mono" style={{ fontSize: 22, fontWeight: 700, color }}>
          {count}
        </span>
      </div>
      <span style={{ fontSize: 11, color: "var(--text-mute)", lineHeight: 1.4 }}>{detail}</span>
    </div>
  );
}

function CronRow({
  name,
  cadence,
  lastAt,
  expectedEverySec,
}: {
  name: string;
  cadence: string;
  lastAt: string | null;
  expectedEverySec: number;
}) {
  const color = cronColor(lastAt, expectedEverySec);
  return (
    <tr>
      <td className="mono" style={{ fontSize: 12 }}>{name}</td>
      <td className="mono dim" style={{ fontSize: 11 }}>{cadence}</td>
      <td style={{ color, fontSize: 12 }}>{timeAgo(lastAt)}</td>
    </tr>
  );
}
