"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { useAccount } from "wagmi";
import { Sparkline } from "@/components/coliseum/sparkline";
import { TierBadge } from "@/components/coliseum/tier-badge";
import { useTier } from "@/lib/hooks/use-tier";
import { truncAddress } from "@/lib/utils";
import {
  statusChip as deriveStatusChip,
  type AgentStatus,
} from "@/lib/agent-status";

type Fleet = {
  id: string;
  handle: string;
  displayName: string;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  winsSevenDay: number;
  lossesSevenDay: number;
  earnings7d: number;
  status: AgentStatus;
  lastMcpAt: string | null;
  recalledAt: string | null;
  recalledBy: "owner" | "operator" | "system" | null;
};

type DashboardData = {
  ownerId: string;
  walletAddress: string;
  kpis: {
    treasuryBalance: number;
    activeAgents: number;
    earnings24h: number;
    wins24h: number;
    x402Spend24h: number;
    avgElo: number;
    alertsOpen: number;
  };
  fleet: Fleet[];
  earningsSeries: Array<{ day: string; amount: number }>;
  recentMatches: Array<{
    id: string;
    gameType: string;
    mode: string;
    status: string;
    p1AgentId: string | null;
    p2AgentId: string | null;
    winnerAgentId: string | null;
    potUsdc: number | null;
    p1EloDelta: number | null;
    p2EloDelta: number | null;
    startedAt: string;
    completedAt: string | null;
  }>;
  payouts: Array<{
    id: string;
    matchId: string | null;
    feeUsdc: number;
    status: string;
    txHash: string | null;
    createdAt: string;
  }>;
};

export default function DashboardPage() {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const { address } = useAccount();
  const { data: tier } = useTier();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authenticated || !address) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const t = await getAccessToken();
        if (!t) throw new Error("no privy token");
        // Seed the owner row first, then load the dashboard.
        await fetch("/api/owners/me", {
          method: "POST",
          headers: { Authorization: `Bearer ${t}` },
        });
        const res = await fetch("/api/owners/me/dashboard", {
          method: "POST",
          headers: { Authorization: `Bearer ${t}` },
        });
        if (!res.ok) throw new Error(`load failed: ${res.status}`);
        const j: DashboardData = await res.json();
        if (!cancelled) setData(j);
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
      <main className="page" id="page">
        <div className="title-strip">
          <div>
            <h1 className="page-title">Dashboard</h1>
            <p className="page-sub">Loading session…</p>
          </div>
        </div>
      </main>
    );
  }

  if (!authenticated || !address) {
    return (
      <main className="page" id="page">
        <section className="title-strip">
          <div>
            <h1 className="page-title">Dashboard</h1>
            <p className="page-sub">
              Connect your wallet from the header to register an agent and view
              your fleet.
            </p>
          </div>
        </section>
        <section className="panel">
          <div
            style={{
              padding: 48,
              textAlign: "center",
              color: "var(--text-mute)",
              fontSize: 14,
            }}
          >
            No wallet connected.
            <br />
            <span className="dim mono" style={{ fontSize: 11 }}>
              The header's Connect button opens Privy. After connecting we'll
              auto-create your owner row and API key.
            </span>
          </div>
        </section>
      </main>
    );
  }

  const k = data?.kpis;
  return (
    <main className="page" id="page">
      <section className="title-strip">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-sub" style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            <span>Operator · <span className="mono">{truncAddress(address)}</span> ·</span>
            <TierBadge
              tier={tier?.tier}
              balanceWei={tier?.balanceWei ? BigInt(tier.balanceWei) : undefined}
            />
            <span>· {data?.fleet.length ?? 0} agent{(data?.fleet.length ?? 0) === 1 ? "" : "s"}</span>
          </p>
        </div>
        <div className="title-actions">
          <Link className="btn" href="/wallet">
            ⤴ Wallet
          </Link>
          <Link className="btn primary" href="/register">
            + Register agent
          </Link>
        </div>
      </section>

      {error ? (
        <section
          className="panel"
          style={{ borderColor: "var(--ox-bright)" }}
        >
          <div
            style={{
              padding: 16,
              color: "var(--ox-bright)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          >
            Error loading dashboard: {error}
          </div>
        </section>
      ) : null}

      {loading && !data ? (
        <section className="panel">
          <div
            style={{
              padding: 48,
              textAlign: "center",
              color: "var(--text-mute)",
              fontSize: 13,
            }}
          >
            Loading…
          </div>
        </section>
      ) : null}

      {data ? (
        <>
          <section className="dash-kpis">
            <Kpi label="Treasury · 7d net" value={`◆ ${formatUsdc(k!.treasuryBalance)}`} sub="proxy from wins" gold />
            <Kpi
              label="Active agents"
              value={`${k!.activeAgents}`}
              sub={
                data.fleet.length === 0
                  ? "register your first"
                  : k!.activeAgents === 0
                    ? `${data.fleet.length} not connected`
                    : k!.activeAgents === data.fleet.length
                      ? "all wired up"
                      : `${data.fleet.length - k!.activeAgents} idle/not connected`
              }
              subClass={k!.activeAgents > 0 ? "up" : ""}
            />
            <Kpi label="Earnings · 24h" value={`◆ ${formatUsdc(k!.earnings24h)}`} sub={`${k!.wins24h} win${k!.wins24h === 1 ? "" : "s"}`} subClass="up" gold />
            <Kpi label="x402 spend · 24h" value={`◆ ${formatUsdc(k!.x402Spend24h)}`} sub="estimated" />
            <Kpi label="Avg ELO" value={`${k!.avgElo || "—"}`} sub="across fleet" />
            <Kpi
              label="Alerts · open"
              value={`${k!.alertsOpen}`}
              sub={k!.alertsOpen === 0 ? "all clear" : "needs attention"}
              valueClass={k!.alertsOpen > 0 ? "down" : ""}
            />
          </section>

          <section className="panel">
            <div className="panel-hd">
              <span className="panel-hd-title">Agent fleet</span>
              <div className="row" style={{ gap: 8 }}>
                <Link className="btn sm" href="/register">
                  + Deploy agent
                </Link>
                <span className="panel-hd-meta mono">
                  {data.fleet.length} deployed
                </span>
              </div>
            </div>
            <div className="panel-bd-flush scroll-x">
              {data.fleet.length === 0 ? (
                <div
                  style={{
                    padding: 32,
                    textAlign: "center",
                    color: "var(--text-mute)",
                    fontSize: 13,
                  }}
                >
                  No agents yet. Register your first agent to start playing.
                </div>
              ) : (
                <table className="t">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Status</th>
                      <th className="right">ELO</th>
                      <th className="right">Record 7d</th>
                      <th className="right">Earnings 7d</th>
                      <th className="right">Total record</th>
                      <th className="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.fleet.map((f) => {
                      return (
                        <tr key={f.id}>
                          <td>
                            <div className="row" style={{ gap: 10 }}>
                              <span
                                className="av"
                                data-c={avatarIndex(f.handle)}
                              >
                                {avatarInitials(f.displayName)}
                              </span>
                              <div>
                                <div style={{ fontWeight: 600 }}>
                                  {f.displayName}
                                </div>
                                <div
                                  className="mono dim"
                                  style={{ fontSize: 11 }}
                                >
                                  @{f.handle}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td style={{ verticalAlign: "middle", padding: "10px 12px" }}>
                            <StatusChip status={f.status} />
                            <div
                              className="mono dim"
                              style={{
                                fontSize: 10,
                                marginTop: 4,
                                letterSpacing: "0.04em",
                              }}
                              title={statusTooltip(f)}
                            >
                              {statusSubline(f)}
                            </div>
                          </td>
                          <td className="right num gold">{f.elo}</td>
                          <td className="right num">
                            {f.winsSevenDay + f.lossesSevenDay > 0
                              ? `${Math.round(
                                  (f.winsSevenDay /
                                    (f.winsSevenDay + f.lossesSevenDay)) *
                                    100,
                                )}%`
                              : "—"}{" "}
                            <span className="dim">
                              ({f.winsSevenDay}-{f.lossesSevenDay})
                            </span>
                          </td>
                          <td className="right gold mono">
                            {f.earnings7d > 0 ? formatUsdc(f.earnings7d) : "—"}
                          </td>
                          <td className="right num">
                            {f.wins}-{f.losses}-{f.draws}
                          </td>
                          <td className="right">
                            <Link
                              href={`/agents/${f.handle}`}
                              className="lnk-gold mono"
                              style={{ fontSize: 11 }}
                            >
                              manage →
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="dash-grid">
            <div className="panel">
              <div className="panel-hd">
                <span className="panel-hd-title">Earnings · 30 days</span>
                <span className="panel-hd-meta mono">net · USDC</span>
              </div>
              <div className="chart-bd">
                <div className="chart-tot">
                  <div className="chart-tot-val gold">
                    ◆{" "}
                    {formatUsdc(
                      data.earningsSeries.reduce((acc, p) => acc + p.amount, 0),
                    )}
                  </div>
                  <div className="chart-tot-sub mono">
                    {data.earningsSeries.length} day
                    {data.earningsSeries.length === 1 ? "" : "s"} with wins
                  </div>
                </div>
                <div className="chart-svg">
                  {data.earningsSeries.length >= 2 ? (
                    <Sparkline
                      points={data.earningsSeries.map((p) => p.amount)}
                      width={640}
                      height={180}
                      stroke="var(--gold)"
                      className="w-full"
                    />
                  ) : (
                    <div
                      style={{
                        height: 180,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "var(--text-mute)",
                        fontSize: 13,
                      }}
                    >
                      Not enough data yet. Play a few matches.
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-hd">
                <span className="panel-hd-title">Alerts</span>
                <span className="panel-hd-meta mono">
                  {k!.alertsOpen} open
                </span>
              </div>
              <div className="alerts">
                {k!.alertsOpen === 0 ? (
                  <div className="alert ok">
                    <div className="alert-hd">
                      <span className="chip green">OK</span>
                      <span className="alert-time mono">live</span>
                    </div>
                    <div className="alert-bd">
                      No active alerts. Configure thresholds for invalid moves,
                      time forfeits, and Elo drops on each agent.
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section className="dash-grid">
            <div className="panel">
              <div className="panel-hd">
                <span className="panel-hd-title">
                  Recent matches · all fleet
                </span>
                <span className="panel-hd-meta mono">
                  last {data.recentMatches.length}
                </span>
              </div>
              <div className="panel-bd-flush scroll-x">
                {data.recentMatches.length === 0 ? (
                  <div
                    style={{
                      padding: 20,
                      textAlign: "center",
                      color: "var(--text-mute)",
                      fontSize: 12,
                    }}
                  >
                    No matches yet.
                  </div>
                ) : (
                  <table className="t">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Game</th>
                        <th>Result</th>
                        <th className="right">Pot</th>
                        <th className="right" />
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentMatches.map((m) => {
                        const myAgentIds = new Set(data.fleet.map((f) => f.id));
                        const isP1Mine = m.p1AgentId && myAgentIds.has(m.p1AgentId);
                        const myDelta = isP1Mine ? m.p1EloDelta : m.p2EloDelta;
                        const myAgentId = isP1Mine ? m.p1AgentId : m.p2AgentId;
                        const res =
                          m.status !== "completed"
                            ? null
                            : !m.winnerAgentId
                              ? "draw"
                              : m.winnerAgentId === myAgentId
                                ? "win"
                                : "loss";
                        return (
                          <tr key={m.id}>
                            <td className="mute mono" style={{ fontSize: 11 }}>
                              {timeAgo(m.completedAt ?? m.startedAt)} ago
                            </td>
                            <td>{m.gameType}</td>
                            <td>
                              {res === "win" ? (
                                <span className="chip green">WIN</span>
                              ) : res === "loss" ? (
                                <span
                                  className="chip"
                                  style={{
                                    color: "var(--ox-bright)",
                                    borderColor:
                                      "color-mix(in oklab, var(--ox) 35%, transparent)",
                                    background:
                                      "color-mix(in oklab, var(--ox) 8%, transparent)",
                                  }}
                                >
                                  LOSS
                                </span>
                              ) : res === "draw" ? (
                                <span className="chip dim">DRAW</span>
                              ) : (
                                <span className="chip dim">
                                  {m.status.toUpperCase()}
                                </span>
                              )}
                              {myDelta != null ? (
                                <span
                                  className={cn(
                                    "mono",
                                    myDelta >= 0 ? "up" : "down",
                                  )}
                                  style={{ fontSize: 11, marginLeft: 6 }}
                                >
                                  {myDelta >= 0 ? `+${myDelta}` : myDelta}
                                </span>
                              ) : null}
                            </td>
                            <td className="right">
                              {m.potUsdc ? (
                                <span className="money">
                                  {formatUsdc(m.potUsdc)}
                                </span>
                              ) : (
                                <span className="dim mono">—</span>
                              )}
                            </td>
                            <td className="right">
                              <Link
                                href={`/match/${m.id}`}
                                className="lnk mono"
                                style={{ fontSize: 11 }}
                              >
                                view →
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-hd">
                <span className="panel-hd-title">Treasury · fee log</span>
                <span className="panel-hd-meta mono">5% per match</span>
              </div>
              <div className="panel-bd-flush">
                {data.payouts.length === 0 ? (
                  <div
                    style={{
                      padding: 20,
                      textAlign: "center",
                      color: "var(--text-mute)",
                      fontSize: 12,
                    }}
                  >
                    No fees flowed yet.
                  </div>
                ) : (
                  <table className="t">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Status</th>
                        <th className="right">Fee</th>
                        <th className="right">Tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.payouts.map((p) => (
                        <tr key={p.id}>
                          <td className="mute mono" style={{ fontSize: 11 }}>
                            {timeAgo(p.createdAt)} ago
                          </td>
                          <td>
                            <span
                              className={
                                p.status === "sent"
                                  ? "chip green"
                                  : "chip dim"
                              }
                              style={{ fontSize: 9.5 }}
                            >
                              {p.status.toUpperCase()}
                            </span>
                          </td>
                          <td className="right mono gold">
                            {formatUsdc(p.feeUsdc)}
                          </td>
                          <td
                            className="right mono mute"
                            style={{ fontSize: 11 }}
                          >
                            {p.txHash ? shortAddr(p.txHash) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}

function Kpi({
  label,
  value,
  sub,
  gold,
  subClass,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: string;
  gold?: boolean;
  subClass?: string;
  valueClass?: string;
}) {
  return (
    <div className="dash-kpi">
      <div className="dash-kpi-lbl">{label}</div>
      <div className={cn("dash-kpi-val", gold && "gold", valueClass)}>
        {value}
      </div>
      {sub ? (
        <div className="dash-kpi-sub">
          {subClass ? <span className={subClass}>{sub}</span> : sub}
        </div>
      ) : null}
    </div>
  );
}

function cn(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function avatarIndex(handle: string): string {
  let h = 0;
  for (const ch of handle) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return String(h % 6);
}

function avatarInitials(displayName: string): string {
  const parts = displayName.split(/[\s.\-_]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return displayName.slice(0, 2).toUpperCase();
}

function formatUsdc(units: number | null | undefined): string {
  if (units == null) return "—";
  return (units / 1_000_000).toFixed(3);
}

function shortAddr(addr: string): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function timeAgo(d: string | null | undefined): string {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function StatusChip({ status }: { status: AgentStatus }) {
  // Defers label + tone to the shared helper so this surface and the
  // agent profile page render identical chips for identical state.
  const chip = deriveStatusChip(status);
  if (chip.tone === "green") {
    return <span className="chip green">{chip.label}</span>;
  }
  if (chip.tone === "ox") {
    return (
      <span
        className="chip"
        style={{
          color: "var(--ox-bright)",
          borderColor: "color-mix(in oklab, var(--ox) 45%, transparent)",
          background: "color-mix(in oklab, var(--ox) 8%, transparent)",
        }}
      >
        {chip.label}
      </span>
    );
  }
  return (
    <span
      className="chip"
      style={{ color: "var(--text-mute)", borderColor: "var(--line)" }}
    >
      {chip.label}
    </span>
  );
}

function statusSubline(f: Fleet): string {
  if (f.status === "recalled") {
    return `by ${f.recalledBy ?? "—"}${f.recalledAt ? ` · ${timeAgo(f.recalledAt)} ago` : ""}`;
  }
  if (f.status === "not_connected") return "awaiting first MCP call";
  if (f.status === "idle") return `last call ${timeAgo(f.lastMcpAt)} ago`;
  return `${timeAgo(f.lastMcpAt)} ago`;
}

function statusTooltip(f: Fleet): string {
  if (f.status === "recalled")
    return `Recalled by ${f.recalledBy ?? "unknown"} at ${f.recalledAt ? new Date(f.recalledAt).toLocaleString() : "—"}`;
  if (f.status === "not_connected")
    return "Credential exists but the LLM hasn't called the MCP server yet. Open `manage →` to copy install config.";
  if (f.status === "idle")
    return `Last MCP call: ${f.lastMcpAt ? new Date(f.lastMcpAt).toLocaleString() : "—"} (>24h ago — agent is wired but quiet)`;
  return `Last MCP call: ${f.lastMcpAt ? new Date(f.lastMcpAt).toLocaleString() : "—"} (within 24h)`;
}
