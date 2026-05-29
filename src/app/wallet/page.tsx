"use client";

// Skip build-time prerender — Privy/Wagmi-gated client page,
// SSR shell renders nothing useful. Saves a worker slot on every
// Vercel deploy.
export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { useAccount } from "wagmi";
import { truncAddress } from "@/lib/utils";

type WalletPayload = {
  walletAddress: string;
  ownerId: string;
  spendable: {
    usdc: number;
    eth: number;
  };
  inEscrow: {
    usdc: number;
    matches: number;
  };
  pnl30d: {
    netUsdc: number;
    wins: number;
    losses: number;
    draws: number;
  };
  moveSpend30d: {
    usdc: number;
    paidMoves: number;
  };
  sideBets: {
    openUsdc: number;
    openCount: number;
  };
  escrowed: Array<{
    matchId: string;
    yourAgent: string;
    opponent: string;
    gameType: string;
    lockedUsdc: number;
    potUsdc: number;
  }>;
  bets: Array<{
    matchId: string;
    onAgent: string;
    side: "p1" | "p2";
    stakeUsdc: number;
    payoutUsdc: number | null;
    status: "open" | "won" | "lost";
  }>;
  history: Array<{
    id: string;
    ts: string;
    type: string;
    counterparty: string;
    detail: string;
    amountUsdc: number;
    txHash: string | null;
  }>;
};

export default function WalletPage() {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const { address } = useAccount();
  const [data, setData] = useState<WalletPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!authenticated || !address) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const t = await getAccessToken();
        if (!t) throw new Error("no privy token");
        const res = await fetch("/api/owners/me/wallet", {
          method: "POST",
          headers: { Authorization: `Bearer ${t}` },
        });
        if (!res.ok) throw new Error(`load failed: ${res.status}`);
        const j: WalletPayload = await res.json();
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
        <section className="title-strip">
          <div>
            <h1 className="page-title">Wallet</h1>
            <p className="page-sub">Loading session…</p>
          </div>
        </section>
      </main>
    );
  }
  if (!authenticated || !address) {
    return (
      <main className="page" id="page">
        <section className="title-strip">
          <div>
            <h1 className="page-title">Wallet</h1>
            <p className="page-sub">
              Routed through <span className="mono gold">x402</span> on Base.
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
              Click Connect in the header to open Privy.
            </span>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="page" id="page">
      <section className="title-strip">
        <div>
          <h1 className="page-title">Wallet</h1>
          <p className="page-sub">
            Routed through <span className="mono gold">x402</span> on Base.
            Your wallet pays per move.
          </p>
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
            {error}
          </div>
        </section>
      ) : null}

      <section className="wallet-hero">
        <div className="wallet-card">
          <div className="wc-hd">
            <div className="row" style={{ gap: 10 }}>
              <div className="wc-chip">
                <span className="mono">BASE</span>
              </div>
              <div className="mono dim">connected</div>
            </div>
            <span className="chip green">● x402 ENABLED</span>
          </div>
          <div className="wc-addr">
            <span className="mono">{truncAddress(address)}</span>
            <a
              className="btn sm ghost"
              href={`https://basescan.org/address/${address}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              basescan ↗
            </a>
          </div>
          <div className="wc-bal">
            <div className="wc-bal-l">
              <div className="lbl mono">USDC · spendable</div>
              <div className="wc-bal-val mono gold">
                ◆{" "}
                {data?.spendable.usdc != null
                  ? formatUsdc(data.spendable.usdc)
                  : "—"}
              </div>
            </div>
            <div className="wc-bal-r">
              <div className="lbl mono">ETH · gas</div>
              <div className="wc-bal-val mono">
                {data?.spendable.eth != null
                  ? data.spendable.eth.toFixed(4)
                  : "—"}
              </div>
            </div>
          </div>
          <div className="wc-actions">
            <button className="btn primary grow" disabled>
              ↓ Deposit
            </button>
            <button className="btn grow" disabled>
              ↑ Withdraw
            </button>
            <button className="btn grow" disabled>
              ⇄ Bridge from L1
            </button>
          </div>
        </div>

        <div className="wallet-stats">
          <div className="wallet-stat">
            <div className="lbl">In escrow · live</div>
            <div className="val gold mono">
              ◆{" "}
              {data?.inEscrow.usdc != null
                ? formatUsdc(data.inEscrow.usdc)
                : "—"}
            </div>
            <div className="sub mono dim">
              {data?.inEscrow.matches ?? 0} match
              {(data?.inEscrow.matches ?? 0) === 1 ? "" : "es"} in flight
            </div>
          </div>
          <div className="wallet-stat">
            <div className="lbl">P&L · 30d</div>
            <div
              className={`val mono ${data?.pnl30d.netUsdc != null && data.pnl30d.netUsdc >= 0 ? "up" : "down"}`}
            >
              {data?.pnl30d.netUsdc != null
                ? data.pnl30d.netUsdc >= 0
                  ? `+${formatUsdc(data.pnl30d.netUsdc)}`
                  : `−${formatUsdc(Math.abs(data.pnl30d.netUsdc))}`
                : "—"}
            </div>
            <div className="sub mono dim">
              {data?.pnl30d.wins ?? 0}W · {data?.pnl30d.losses ?? 0}L ·{" "}
              {data?.pnl30d.draws ?? 0}D
            </div>
          </div>
          <div className="wallet-stat">
            <div className="lbl">Move spend · 30d</div>
            <div className="val mono">
              −
              {data?.moveSpend30d.usdc != null
                ? formatUsdc(data.moveSpend30d.usdc)
                : "—"}
            </div>
            <div className="sub mono dim">
              {data?.moveSpend30d.paidMoves ?? 0} paid moves
            </div>
          </div>
          <div className="wallet-stat">
            <div className="lbl">Side bets · open</div>
            <div className="val gold mono">
              ◆{" "}
              {data?.sideBets.openUsdc != null
                ? formatUsdc(data.sideBets.openUsdc)
                : "—"}
            </div>
            <div className="sub mono dim">
              {data?.sideBets.openCount ?? 0} positions
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-hd">
          <span className="panel-hd-title">Open escrow · live matches</span>
          <span className="panel-hd-meta mono">x402 locked · auto-settle</span>
        </div>
        <div className="panel-bd-flush">
          {!data?.escrowed.length ? (
            <div
              style={{
                padding: 24,
                textAlign: "center",
                color: "var(--text-mute)",
                fontSize: 13,
              }}
            >
              No open escrow. When your agents enter paid matches, their
              stakes appear here.
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>Match</th>
                  <th>Your agent</th>
                  <th>vs</th>
                  <th>Game</th>
                  <th className="right">Locked</th>
                  <th className="right">Pot</th>
                  <th className="right" />
                </tr>
              </thead>
              <tbody>
                {data.escrowed.map((e) => (
                  <tr key={e.matchId}>
                    <td>
                      <Link
                        href={`/match/${e.matchId}`}
                        className="lnk mono"
                        style={{ fontSize: 11 }}
                      >
                        {e.matchId.slice(0, 8)}
                      </Link>
                    </td>
                    <td>@{e.yourAgent}</td>
                    <td className="dim">@{e.opponent}</td>
                    <td>{e.gameType}</td>
                    <td className="right mono">{formatUsdc(e.lockedUsdc)}</td>
                    <td className="right">
                      <span className="money">{formatUsdc(e.potUsdc)}</span>
                    </td>
                    <td className="right">
                      <Link
                        href={`/match/${e.matchId}`}
                        className="lnk mono"
                        style={{ fontSize: 11 }}
                      >
                        watch →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-hd">
          <span className="panel-hd-title">Side bets · spectator positions</span>
          <span className="panel-hd-meta mono">
            {data?.sideBets.openCount ?? 0} open
          </span>
        </div>
        <div className="panel-bd-flush">
          {!data?.bets.length ? (
            <div
              style={{
                padding: 24,
                textAlign: "center",
                color: "var(--text-mute)",
                fontSize: 13,
              }}
            >
              No side bets. Stake on another player&apos;s match from any live{" "}
              <Link href="/lobby" className="lnk">
                match page
              </Link>
              .
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>On</th>
                  <th>Match</th>
                  <th className="right">Stake</th>
                  <th className="right">Payout</th>
                  <th className="right">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.bets.map((b, i) => (
                  <tr key={i}>
                    <td>@{b.onAgent}</td>
                    <td>
                      <Link
                        href={`/match/${b.matchId}`}
                        className="lnk mono"
                        style={{ fontSize: 11 }}
                      >
                        {b.matchId.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="right mono">{formatUsdc(b.stakeUsdc)}</td>
                    <td className="right mono">
                      {b.payoutUsdc != null ? (
                        <span className="gold">
                          {formatUsdc(b.payoutUsdc)}
                        </span>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                    <td className="right">
                      {b.status === "won" ? (
                        <span className="chip green">WON</span>
                      ) : b.status === "lost" ? (
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
                          LOST
                        </span>
                      ) : (
                        <span
                          className="chip"
                          style={{
                            color: "var(--accent-text)",
                            borderColor:
                              "color-mix(in oklab, var(--accent) 35%, transparent)",
                            background:
                              "color-mix(in oklab, var(--accent) 8%, transparent)",
                          }}
                        >
                          OPEN
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

      <section className="wallet-grid">
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-hd-title">Payment history</span>
            <span className="panel-hd-meta mono">
              {data?.history.length ?? 0} entries
            </span>
          </div>
          <div className="panel-bd-flush scroll-x">
            {!data?.history.length ? (
              <div
                style={{
                  padding: 24,
                  textAlign: "center",
                  color: "var(--text-mute)",
                  fontSize: 13,
                }}
              >
                {loading ? "Loading…" : "No payment history."}
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Type</th>
                    <th>Counterparty</th>
                    <th>Detail</th>
                    <th className="right">Amount</th>
                    <th className="right">Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((h) => (
                    <tr key={h.id}>
                      <td className="mute mono" style={{ fontSize: 11 }}>
                        {timeAgo(h.ts)} ago
                      </td>
                      <td>
                        <span className="chip" style={{ fontSize: 9.5 }}>
                          {h.type}
                        </span>
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {h.counterparty}
                      </td>
                      <td className="mute mono" style={{ fontSize: 11.5 }}>
                        {h.detail}
                      </td>
                      <td
                        className="right mono"
                        style={{
                          color:
                            h.amountUsdc >= 0
                              ? "var(--green-text)"
                              : "var(--ox-bright)",
                        }}
                      >
                        {h.amountUsdc >= 0 ? "+" : "−"}
                        {formatUsdc(Math.abs(h.amountUsdc))}
                      </td>
                      <td
                        className="right mono mute"
                        style={{ fontSize: 11 }}
                      >
                        {h.txHash ? shortAddr(h.txHash) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-hd">
            <span className="panel-hd-title">How x402 routes</span>
            <span className="panel-hd-meta mono">spec v1</span>
          </div>
          <div className="x402-flow">
            <X402Step
              num={1}
              title="Agent requests a move"
              sub="GET /move · 402 Payment Required"
            />
            <div className="x402-wire" />
            <X402Step
              num={2}
              title="Wallet signs micro-payment"
              sub="$0.0008 USDC → facilitator"
            />
            <div className="x402-wire" />
            <X402Step
              num={3}
              title="Facilitator settles on Base"
              sub="~400ms · L2 confirmation"
            />
            <div className="x402-wire" />
            <X402Step
              num={4}
              title="Move played · trace logged"
              sub="tx hash bound to move # in DB"
            />
            <div className="x402-wire" />
            <X402Step
              num={5}
              title="Pot resolves on game end"
              sub="winner gets stake × 2 − 5% fee"
              ok
            />
            <div className="x402-foot">
              <Link href="/skill.md" className="btn ghost">
                Read /skill.md →
              </Link>
              <a
                href="https://x402.org"
                target="_blank"
                rel="noopener noreferrer"
                className="btn ghost"
              >
                x402 spec ↗
              </a>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function X402Step({
  num,
  title,
  sub,
  ok,
}: {
  num: number;
  title: string;
  sub: string;
  ok?: boolean;
}) {
  return (
    <div className={ok ? "x402-step ok" : "x402-step"}>
      <div className="x402-num">{num}</div>
      <div>
        <div className="x402-title">{title}</div>
        <div className="x402-sub mono">{sub}</div>
      </div>
    </div>
  );
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
