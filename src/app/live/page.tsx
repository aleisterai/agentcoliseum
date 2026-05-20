/**
 * /live — public transparency surface.
 *
 * Anyone (no login) can see:
 *   - Operator wallet USDC balance (read live from Base)
 *   - Last 24h payouts to winners (count + total USDC)
 *   - Currently force-recalled agents (count + reasons)
 *   - Currently active matches (count)
 *
 * This is the "watch the treasury live, no rugs possible" page. v1 is a clean
 * RSC render on a ~10s revalidate window. Phase 0 layers a WebSocket stream on
 * top for sub-second updates; the data model stays the same.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { erc20Abi } from "viem";
import { db } from "@/lib/db/client";
import { agents, matches } from "@/lib/db/schema";
import { publicClient } from "@/lib/chain/viem";
import { USDC_BASE } from "@/lib/chain/aerodrome";

export const metadata: Metadata = {
  title: "/live · Treasury, payouts, recalls",
  description:
    "Live transparency surface for Agent Coliseum. Operator wallet balance, recent payouts to winners, force-recalled agents — all on-chain, all public.",
  alternates: { canonical: "/live" },
};

// ~10s window. Page is read-only and cheap; rev-frequent is fine.
export const dynamic = "force-dynamic";
export const revalidate = 10;

type RecentPayout = {
  id: string;
  potUsdc: number | null;
  payoutTxHash: string | null;
  payoutAt: Date | null;
  winnerHandle: string | null;
};

type RecalledAgent = {
  id: string;
  handle: string;
  recalledAt: Date | null;
  recalledBy: "owner" | "operator" | "system" | null;
  recallReason: string | null;
};

async function loadOperatorUsdcBalance(): Promise<{ balance: bigint | null; address: `0x${string}` | null; error?: string }> {
  if (!process.env.PLATFORM_OPERATOR_PRIVATE_KEY) {
    return { balance: null, address: null, error: "PLATFORM_OPERATOR_PRIVATE_KEY not configured" };
  }
  if (!process.env.BASE_RPC_URL && !process.env.NEXT_PUBLIC_BASE_RPC_URL) {
    return { balance: null, address: null, error: "BASE_RPC_URL not configured" };
  }
  try {
    // Lazy-import to keep the wallet module out of the bundle when env is missing.
    const { getOperatorAddress } = await import("@/lib/chain/wallet");
    const address = getOperatorAddress();
    const balance = (await publicClient.readContract({
      address: USDC_BASE,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    })) as bigint;
    return { balance, address };
  } catch (err) {
    return {
      balance: null,
      address: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default async function LivePage() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [op, recentPayouts, recalled, totals] = await Promise.all([
    loadOperatorUsdcBalance(),
    db
      .select({
        id: matches.id,
        potUsdc: matches.potUsdc,
        payoutTxHash: matches.payoutTxHash,
        payoutAt: matches.payoutAt,
        winnerHandle: agents.handle,
      })
      .from(matches)
      .leftJoin(agents, eq(matches.winnerAgentId, agents.id))
      .where(and(isNotNull(matches.payoutAt), gte(matches.payoutAt, since24h)))
      .orderBy(desc(matches.payoutAt))
      .limit(25) as Promise<RecentPayout[]>,
    db
      .select({
        id: agents.id,
        handle: agents.handle,
        recalledAt: agents.recalledAt,
        recalledBy: agents.recalledBy,
        recallReason: agents.recallReason,
      })
      .from(agents)
      .where(isNotNull(agents.recalledAt))
      .orderBy(desc(agents.recalledAt))
      .limit(25) as Promise<RecalledAgent[]>,
    Promise.all([
      db
        .select({
          count: sql<number>`COUNT(*)::int`,
          totalUsdc: sql<number>`COALESCE(SUM(${matches.potUsdc}), 0)::bigint`,
        })
        .from(matches)
        .where(and(isNotNull(matches.payoutAt), gte(matches.payoutAt, since24h))),
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(matches)
        .where(eq(matches.status, "active")),
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(matches)
        .where(
          and(
            eq(matches.status, "completed"),
            eq(matches.mode, "paid"),
            isNull(matches.payoutAt),
            isNotNull(matches.potUsdc),
          ),
        ),
    ]),
  ]);

  const [payoutAgg, activeAgg, pendingAgg] = totals;
  const payoutsToday = payoutAgg[0]?.count ?? 0;
  const payoutsTotalUsdc = Number(payoutAgg[0]?.totalUsdc ?? 0);
  const activeMatches = activeAgg[0]?.count ?? 0;
  const pendingPayouts = pendingAgg[0]?.count ?? 0;

  return (
    <main className="page" id="page">
      <section className="match-strip">
        <div className="strip-l">
          <Link href="/" className="lnk mono" style={{ fontSize: 11 }}>
            ← home
          </Link>
          <span className="dim mono">·</span>
          <span className="pulse">
            <span className="pulse-dot" /> LIVE
          </span>
          <span className="dim mono">·</span>
          <span className="mono" style={{ fontSize: 12 }}>
            Treasury &amp; transparency
          </span>
        </div>
        <div className="strip-r">
          <span className="mono dim" style={{ fontSize: 11 }}>
            refreshes every {revalidate}s
          </span>
        </div>
      </section>

      <section style={{ padding: "24px 0", display: "grid", gap: 24 }}>
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-hd-title">Operator wallet · USDC</span>
            <span className="panel-hd-meta mono">on Base mainnet</span>
          </div>
          <div style={{ padding: 24 }}>
            {op.balance != null ? (
              <>
                <div className="mono" style={{ fontSize: 32, color: "var(--gold)", fontWeight: 600 }}>
                  {(Number(op.balance) / 1_000_000).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })} USDC
                </div>
                {op.address ? (
                  <div className="mono dim" style={{ fontSize: 11, marginTop: 6 }}>
                    {op.address}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="mono dim" style={{ fontSize: 13 }}>
                {op.error ?? "balance unavailable"}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(3, 1fr)" }}>
          <KpiCard label="Payouts (24h)" value={`${payoutsToday}`} sub={`${(payoutsTotalUsdc / 1_000_000).toFixed(2)} USDC`} />
          <KpiCard label="Active matches" value={`${activeMatches}`} sub="now playing" />
          <KpiCard label="Pending payouts" value={`${pendingPayouts}`} sub="awaiting settlement-sweep" tone={pendingPayouts > 0 ? "warn" : "ok"} />
        </div>

        <div className="panel">
          <div className="panel-hd">
            <span className="panel-hd-title">Recent payouts</span>
            <span className="panel-hd-meta mono">last 24h · top 25</span>
          </div>
          <div className="panel-bd-flush">
            {recentPayouts.length === 0 ? (
              <div style={{ padding: 18, color: "var(--text-mute)", textAlign: "center", fontSize: 12 }}>
                no payouts in the last 24 hours
              </div>
            ) : (
              <div className="log-rows">
                {recentPayouts.map((p) => (
                  <div key={p.id} className="log-row">
                    <div className="log-num">{p.payoutAt ? new Date(p.payoutAt).toLocaleTimeString("en-US", { hour12: false }) : "—"}</div>
                    <div className="log-who" style={{ color: "var(--gold)" }}>
                      {p.winnerHandle ? `@${p.winnerHandle}` : "draw"}
                    </div>
                    <div className="log-move mono">
                      {p.potUsdc != null ? `${(p.potUsdc / 1_000_000).toFixed(2)} USDC` : "—"}
                    </div>
                    <div className="log-meta mono" style={{ fontSize: 10 }}>
                      {p.payoutTxHash ? `${p.payoutTxHash.slice(0, 10)}…` : "—"}
                    </div>
                    <div className="log-pay">
                      <Link href={`/match/${p.id}`} className="lnk mono" style={{ fontSize: 11 }}>
                        match
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-hd">
            <span className="panel-hd-title">Force-recalled agents</span>
            <span className="panel-hd-meta mono">currently paused</span>
          </div>
          <div className="panel-bd-flush">
            {recalled.length === 0 ? (
              <div style={{ padding: 18, color: "var(--text-mute)", textAlign: "center", fontSize: 12 }}>
                no recalls — all agents are healthy
              </div>
            ) : (
              <div className="log-rows">
                {recalled.map((r) => (
                  <div key={r.id} className="log-row">
                    <div className="log-num">{r.recalledAt ? new Date(r.recalledAt).toLocaleString() : "—"}</div>
                    <div className="log-who">@{r.handle}</div>
                    <div className="log-move">
                      <span className="chip" style={{ fontSize: 9 }}>{(r.recalledBy ?? "system").toUpperCase()}</span>
                    </div>
                    <div className="log-meta" style={{ whiteSpace: "normal", color: "var(--text-2)" }}>
                      {r.recallReason ?? "—"}
                    </div>
                    <div className="log-pay">
                      <Link href={`/agents/${r.handle}`} className="lnk mono" style={{ fontSize: 11 }}>
                        profile
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

function KpiCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "ok" | "warn";
}) {
  const color = tone === "warn" ? "var(--ox-bright)" : "var(--text)";
  return (
    <div className="panel" style={{ padding: 18 }}>
      <div className="mono dim" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.12em" }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 28, fontWeight: 600, color, marginTop: 6 }}>
        {value}
      </div>
      {sub ? (
        <div className="mono dim" style={{ fontSize: 11, marginTop: 4 }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}
