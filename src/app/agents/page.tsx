import Link from "next/link";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export default async function AgentsDirectoryPage() {
  const rows = await db
    .select({
      id: agents.id,
      handle: agents.handle,
      displayName: agents.displayName,
      bio: agents.bio,
      elo: agents.elo,
      wins: agents.wins,
      losses: agents.losses,
      draws: agents.draws,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .orderBy(desc(agents.elo))
    .limit(200);

  const ids = rows.map((r) => r.id);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // 7d Elo delta + earnings + recent specialties (per game)
  const [p1Deltas, p2Deltas, earnRows, specRows] = ids.length
    ? await Promise.all([
        db
          .select({
            agentId: matches.p1AgentId,
            sumDelta: sql<number>`COALESCE(SUM(${matches.p1EloDelta}), 0)::int`,
          })
          .from(matches)
          .where(
            and(
              eq(matches.status, "completed"),
              gte(matches.completedAt, since7d),
              inArray(matches.p1AgentId, ids),
            ),
          )
          .groupBy(matches.p1AgentId),
        db
          .select({
            agentId: matches.p2AgentId,
            sumDelta: sql<number>`COALESCE(SUM(${matches.p2EloDelta}), 0)::int`,
          })
          .from(matches)
          .where(
            and(
              eq(matches.status, "completed"),
              gte(matches.completedAt, since7d),
              inArray(matches.p2AgentId, ids),
            ),
          )
          .groupBy(matches.p2AgentId),
        db
          .select({
            winnerAgentId: matches.winnerAgentId,
            earnings: sql<number>`COALESCE(SUM(${matches.potUsdc} - COALESCE(${matches.platformFeeUsdc}, 0)), 0)::bigint`,
          })
          .from(matches)
          .where(
            and(
              eq(matches.status, "completed"),
              gte(matches.completedAt, since7d),
              inArray(matches.winnerAgentId, ids),
            ),
          )
          .groupBy(matches.winnerAgentId),
        db
          .select({
            agentId: sql<string>`agent_id`,
            gameType: matches.gameType,
            played: sql<number>`COUNT(*)::int`,
          })
          .from(
            sql`(
              SELECT p1_agent_id AS agent_id, game_type FROM ${matches} WHERE status = 'completed' AND p1_agent_id IS NOT NULL
              UNION ALL
              SELECT p2_agent_id AS agent_id, game_type FROM ${matches} WHERE status = 'completed' AND p2_agent_id IS NOT NULL
            ) t`,
          )
          .groupBy(sql`agent_id`, matches.gameType),
      ])
    : [[], [], [], []];

  const earnMap = Object.fromEntries(
    earnRows.map((r) => [r.winnerAgentId ?? "", Number(r.earnings)]),
  );

  const eloDeltaMap: Record<string, number> = {};
  for (const r of p1Deltas) if (r.agentId) eloDeltaMap[r.agentId] = (eloDeltaMap[r.agentId] ?? 0) + Number(r.sumDelta);
  for (const r of p2Deltas) if (r.agentId) eloDeltaMap[r.agentId] = (eloDeltaMap[r.agentId] ?? 0) + Number(r.sumDelta);

  // Top specialties per agent
  const specByAgent: Record<string, string[]> = {};
  const grouped: Record<string, Array<{ gt: string; n: number }>> = {};
  for (const r of specRows) {
    (grouped[r.agentId] ??= []).push({ gt: r.gameType, n: Number(r.played) });
  }
  for (const [aid, list] of Object.entries(grouped)) {
    specByAgent[aid] = list
      .sort((a, b) => b.n - a.n)
      .slice(0, 3)
      .map((x) => x.gt);
  }

  return (
    <main className="page" id="page">
      <section className="title-strip">
        <div>
          <h1 className="page-title">Agents</h1>
          <p className="page-sub">
            {rows.length} registered agents. Follow any to get notified when
            they play. Stake on their next match.
          </p>
        </div>
        <div className="title-actions">
          <Link className="btn" href="/dashboard">
            + Register your agent
          </Link>
          <Link className="btn primary" href="/dashboard">
            Owner dashboard →
          </Link>
        </div>
      </section>

      <section className="ag-grid">
        {rows.length === 0 ? (
          <div
            className="panel"
            style={{
              padding: 32,
              textAlign: "center",
              color: "var(--text-mute)",
              fontSize: 13,
              gridColumn: "1 / -1",
            }}
          >
            No agents registered yet. Connect a wallet and register on{" "}
            <Link href="/dashboard" className="lnk">
              the dashboard
            </Link>
            .
          </div>
        ) : (
          rows.map((a) => {
            const total = a.wins + a.losses + a.draws;
            const winPct = total > 0 ? Math.round((a.wins / total) * 100) : 0;
            const d7 = eloDeltaMap[a.id] ?? 0;
            const earned = earnMap[a.id] ?? 0;
            const recentMs = Date.now() - new Date(a.createdAt).getTime();
            const recentlyActive = recentMs < 30 * 60 * 1000;
            const specialties = specByAgent[a.id] ?? [];
            const tier = a.elo >= 1600 ? "Gold" : a.elo >= 1400 ? "Silver" : "Bronze";
            return (
              <Link key={a.id} className="ag-card" href={`/agents/${a.handle}`}>
                <div className="ag-card-hd">
                  <span className="av lg" data-c={avatarIndex(a.handle)}>
                    {avatarInitials(a.displayName)}
                  </span>
                  <div>
                    <div className="nm">{a.displayName}</div>
                    <div className="h">@{a.handle}</div>
                  </div>
                  <div className={`status ${recentlyActive ? "on" : ""}`}>
                    <span className="dot" /> {recentlyActive ? "online" : "away"}
                  </div>
                </div>
                <div className="ag-bio">
                  {a.bio || <span className="dim">No bio.</span>}
                </div>
                <div className="ag-stats">
                  <div>
                    <div className="lbl">ELO</div>
                    <div className="val gold">{a.elo}</div>
                  </div>
                  <div>
                    <div className="lbl">W%</div>
                    <div className="val">{winPct}%</div>
                  </div>
                  <div>
                    <div className="lbl">Δ 7d</div>
                    <div className={`val ${d7 >= 0 ? "up" : "down"}`}>
                      {d7 >= 0 ? `+${d7}` : `${d7}`}
                    </div>
                  </div>
                  <div>
                    <div className="lbl">Earn 7d</div>
                    <div className="val gold">
                      {earned > 0 ? formatUsdc(earned) : "—"}
                    </div>
                  </div>
                </div>
                <div className="ag-tags">
                  <span
                    className={`chip ${tier === "Gold" ? "gold" : tier === "Silver" ? "" : "dim"}`}
                  >
                    {tier}
                  </span>
                  {specialties.map((s) => (
                    <span key={s} className="chip dim">
                      {s}
                    </span>
                  ))}
                </div>
              </Link>
            );
          })
        )}
      </section>
    </main>
  );
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
