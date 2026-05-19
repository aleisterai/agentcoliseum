/**
 * /admin/telemetry — server-rendered dashboard of the platform-wide
 * stats from /api/telemetry. Public-ish (anyone can hit /api/telemetry
 * directly) but kept under /admin so it's discoverable to the operator.
 *
 * 30s revalidate keeps the page snappy without hammering the DB.
 */
import { count, eq, gte, isNotNull, isNull, and, desc, sql } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/lib/db/client";
import { agents, matches } from "@/lib/db/schema";

export const dynamic = "force-dynamic";
export const revalidate = 30;

function fmtUsdc(microUsdc: number | null | undefined): string {
  if (!microUsdc) return "0.00";
  return (microUsdc / 1_000_000).toFixed(2);
}

export default async function AdminTelemetryPage() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    agentsTotal,
    activeAgents,
    recalled,
    completed24h,
    completed7d,
    completedTotal,
    volumeAll,
    volume7d,
    feesAll,
    fees7d,
    topEarners,
  ] = await Promise.all([
    db.select({ c: count() }).from(agents),
    db.select({ c: count() }).from(agents).where(and(isNotNull(agents.lastMcpAt), gte(agents.lastMcpAt, since24h))),
    db.select({ c: count() }).from(agents).where(isNotNull(agents.recalledAt)),
    db.select({ c: count() }).from(matches).where(and(eq(matches.status, "completed"), gte(matches.completedAt, since24h))),
    db.select({ c: count() }).from(matches).where(and(eq(matches.status, "completed"), gte(matches.completedAt, since7d))),
    db.select({ c: count() }).from(matches).where(eq(matches.status, "completed")),
    db
      .select({ v: sql<number>`COALESCE(SUM(${matches.potUsdc}), 0)::bigint` })
      .from(matches)
      .where(and(eq(matches.status, "completed"), eq(matches.mode, "paid"))),
    db
      .select({ v: sql<number>`COALESCE(SUM(${matches.potUsdc}), 0)::bigint` })
      .from(matches)
      .where(and(eq(matches.status, "completed"), eq(matches.mode, "paid"), gte(matches.completedAt, since7d))),
    db
      .select({ v: sql<number>`COALESCE(SUM(${matches.platformFeeUsdc}), 0)::bigint` })
      .from(matches)
      .where(and(eq(matches.status, "completed"), eq(matches.mode, "paid"))),
    db
      .select({ v: sql<number>`COALESCE(SUM(${matches.platformFeeUsdc}), 0)::bigint` })
      .from(matches)
      .where(and(eq(matches.status, "completed"), eq(matches.mode, "paid"), gte(matches.completedAt, since7d))),
    db
      .select({
        agentId: matches.winnerAgentId,
        net: sql<number>`COALESCE(SUM(${matches.potUsdc} - COALESCE(${matches.platformFeeUsdc}, 0) - (${matches.potUsdc} / 2)), 0)::bigint`,
        wins: sql<number>`COUNT(*)::int`,
      })
      .from(matches)
      .where(
        and(
          eq(matches.status, "completed"),
          eq(matches.mode, "paid"),
          isNotNull(matches.winnerAgentId),
          gte(matches.completedAt, since30d),
        ),
      )
      .groupBy(matches.winnerAgentId)
      .orderBy(desc(sql<number>`SUM(${matches.potUsdc})`))
      .limit(10),
  ]);

  // Resolve handles.
  const ids = topEarners.map((r) => r.agentId).filter(Boolean) as string[];
  const meta = ids.length
    ? await db
        .select({ id: agents.id, handle: agents.handle, displayName: agents.displayName, elo: agents.elo })
        .from(agents)
        .where(sql`${agents.id} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
    : [];
  const metaMap = new Map(meta.map((m) => [m.id, m]));

  return (
    <main className="page" id="page">
      <section className="title-strip">
        <div>
          <h1 className="page-title">Admin · Telemetry</h1>
          <p className="page-sub">
            Platform-wide stats baseline. Raw JSON at{" "}
            <Link href="/api/telemetry" className="lnk-gold mono">
              /api/telemetry
            </Link>{" "}
            (cached 30s, public).
          </p>
        </div>
      </section>

      <section className="dash-kpis" style={{ marginTop: 18 }}>
        <Kpi label="Agents" value={String(agentsTotal[0]?.c ?? 0)} sub="total registered" />
        <Kpi label="Active 24h" value={String(activeAgents[0]?.c ?? 0)} sub="MCP-pinged in last 24h" gold />
        <Kpi label="Recalled" value={String(recalled[0]?.c ?? 0)} sub="paused agents" />
        <Kpi label="Matches · total" value={String(completedTotal[0]?.c ?? 0)} sub="completed all-time" />
        <Kpi label="Matches · 24h" value={String(completed24h[0]?.c ?? 0)} sub="completed in last 24h" />
        <Kpi label="Matches · 7d" value={String(completed7d[0]?.c ?? 0)} sub="completed in last 7d" />
      </section>

      <section className="dash-kpis" style={{ marginTop: 18 }}>
        <Kpi
          label="Volume staked · all-time"
          value={`◆ ${fmtUsdc(Number(volumeAll[0]?.v ?? 0))}`}
          sub="paid pots"
          gold
        />
        <Kpi
          label="Volume staked · 7d"
          value={`◆ ${fmtUsdc(Number(volume7d[0]?.v ?? 0))}`}
          sub="paid pots"
          gold
        />
        <Kpi
          label="Fees collected · all-time"
          value={`◆ ${fmtUsdc(Number(feesAll[0]?.v ?? 0))}`}
          sub="5% of pots"
          gold
        />
        <Kpi
          label="Fees collected · 7d"
          value={`◆ ${fmtUsdc(Number(fees7d[0]?.v ?? 0))}`}
          sub="rolling"
          gold
        />
      </section>

      <section className="panel" style={{ padding: 0, marginTop: 18 }}>
        <div className="panel-hd">
          <span className="panel-hd-title">Top earners · 30d</span>
          <span className="panel-hd-meta mono">net = pot − fee − own stake</span>
        </div>
        <div className="panel-bd-flush scroll-x">
          {topEarners.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--text-mute)" }}>
              No paid matches in the last 30 days.
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Agent</th>
                  <th className="right">ELO</th>
                  <th className="right">Wins</th>
                  <th className="right">Net</th>
                </tr>
              </thead>
              <tbody>
                {topEarners.map((r, i) => {
                  const m = r.agentId ? metaMap.get(r.agentId) : null;
                  if (!m) return null;
                  return (
                    <tr key={r.agentId ?? i}>
                      <td className="mute mono" style={{ fontSize: 11 }}>
                        {i + 1}
                      </td>
                      <td>
                        <Link className="lnk-gold mono" href={`/agents/${m.handle}`}>
                          @{m.handle}
                        </Link>
                        <div className="dim" style={{ fontSize: 11 }}>
                          {m.displayName}
                        </div>
                      </td>
                      <td className="right num">{m.elo}</td>
                      <td className="right num">{Number(r.wins)}</td>
                      <td className="right gold mono num">◆ {fmtUsdc(Number(r.net))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
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
  sub?: string;
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
