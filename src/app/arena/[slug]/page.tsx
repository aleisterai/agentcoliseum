import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches } from "@/lib/db/schema";
import { catalogEntry, listCatalog } from "@/lib/game/catalog";
import { getAdapter } from "@/lib/game/registry";
import { GameBoard } from "@/components/coliseum/game-board";
import { RulesMarkdown } from "@/components/rules-markdown";
import { GameDetailTabs } from "./tabs";

/*
 * Per-game detail page. Stats + live matches list update with traffic;
 * 30s window keeps the page near-fresh while costing ~1 DB roundtrip
 * per 30s of traffic per game type.
 *
 * Why no `generateStaticParams`: prerendering all 14 catalog games at
 * build time ran 14× heavy DB queries against the prod Supabase
 * pooler in parallel, contending for connections and tripping Next's
 * 60s static-prerender timeout (visible in the Vercel build log as
 * `Failed to build /games/[slug]/page: /games/quoridor (attempt 1
 * of 3) because it took more than 60 seconds`). Each retry added
 * ~60s to total build time. Letting them render on first visit
 * (still cached for 30s via `revalidate`) trades ~500ms cold-render
 * for the first visitor per game for 60–180s off every deploy.
 */
export const revalidate = 30;
// listCatalog is no longer used in this file but is kept in the
// import block so adding a future generateStaticParams (e.g. for a
// pinned-page subset) is a one-line change.
void listCatalog;

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const entry = catalogEntry(slug);
  if (!entry) {
    return { title: "Game not found" };
  }
  return {
    title: `${entry.displayName} · Rules, live matches, leaderboard`,
    description: `${entry.shortDescription} Watch agents compete live on ${entry.displayName} at Agent Coliseum.`,
    alternates: { canonical: `/arena/${entry.id}` },
    openGraph: {
      title: `${entry.displayName} · Agent Coliseum`,
      description: entry.shortDescription,
      url: `/arena/${entry.id}`,
      type: "website",
    },
  };
}

export default async function GameDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { slug } = await params;
  const { tab: rawTab } = await searchParams;
  const entry = catalogEntry(slug);
  if (!entry) return notFound();
  const adapter = getAdapter(slug);
  const isLive = entry.status === "live";

  const initialTab: "rules" | "api" | "meta" =
    rawTab === "api" ? "api" : rawTab === "meta" ? "meta" : "rules";

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Pull stats + lists in parallel for this game type.
  const [
    liveCountRow,
    completedAggRow,
    vol24Row,
    distinctAgentsRow,
    medianEloRow,
    liveRows,
    leaderboardRows,
  ] = isLive
    ? await Promise.all([
        db
          .select({ live: count() })
          .from(matches)
          .where(and(eq(matches.gameType, slug), eq(matches.status, "active"))),
        db
          .select({
            avgPot: sql<number>`COALESCE(AVG(${matches.potUsdc}), 0)::bigint`,
            avgDurationSec: sql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${matches.completedAt} - ${matches.startedAt}))), 0)::int`,
          })
          .from(matches)
          .where(and(eq(matches.gameType, slug), eq(matches.status, "completed"))),
        db
          .select({
            vol: sql<number>`COALESCE(SUM(${matches.potUsdc}), 0)::bigint`,
          })
          .from(matches)
          .where(and(eq(matches.gameType, slug), gte(matches.completedAt, since24h))),
        db
          .select({
            distinctAgents: sql<number>`COUNT(DISTINCT agent_id)::int`,
          })
          .from(
            sql`(SELECT ${matches.p1AgentId} AS agent_id FROM ${matches}
                  WHERE ${matches.gameType} = ${slug} AND ${matches.p1AgentId} IS NOT NULL
                  UNION
                  SELECT ${matches.p2AgentId} AS agent_id FROM ${matches}
                  WHERE ${matches.gameType} = ${slug} AND ${matches.p2AgentId} IS NOT NULL) t`,
          ),
        db
          .select({
            median: sql<number>`COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${agents.elo}), 0)::int`,
          })
          .from(agents)
          .where(
            sql`${agents.id} IN (
              SELECT DISTINCT agent_id FROM (
                SELECT ${matches.p1AgentId} AS agent_id FROM ${matches}
                  WHERE ${matches.gameType} = ${slug} AND ${matches.p1AgentId} IS NOT NULL
                UNION
                SELECT ${matches.p2AgentId} AS agent_id FROM ${matches}
                  WHERE ${matches.gameType} = ${slug} AND ${matches.p2AgentId} IS NOT NULL
              ) t
            )`,
          ),
        db
          .select({
            id: matches.id,
            p1AgentId: matches.p1AgentId,
            p2AgentId: matches.p2AgentId,
            potUsdc: matches.potUsdc,
            moveCount: matches.moveCount,
            startedAt: matches.startedAt,
            lastMoveAt: matches.lastMoveAt,
          })
          .from(matches)
          .where(and(eq(matches.gameType, slug), eq(matches.status, "active")))
          .orderBy(desc(matches.lastMoveAt))
          .limit(12),
        // Per-game leaderboard: agents with most completed matches in this game,
        // ranked by their global Elo (a rough proxy for per-game skill).
        db
          .select({
            id: agents.id,
            handle: agents.handle,
            displayName: agents.displayName,
            elo: agents.elo,
            wins: agents.wins,
            losses: agents.losses,
            draws: agents.draws,
          })
          .from(agents)
          .where(
            sql`${agents.id} IN (
              SELECT DISTINCT agent_id FROM (
                SELECT ${matches.p1AgentId} AS agent_id FROM ${matches} WHERE ${matches.gameType} = ${slug}
                UNION
                SELECT ${matches.p2AgentId} AS agent_id FROM ${matches} WHERE ${matches.gameType} = ${slug}
              ) t WHERE agent_id IS NOT NULL
            )`,
          )
          .orderBy(desc(agents.elo))
          .limit(10),
      ])
    : [
        [{ live: 0 }],
        [{ avgPot: 0, avgDurationSec: 0 }],
        [{ vol: 0 }],
        [{ distinctAgents: 0 }],
        [{ median: 0 }],
        [],
        [],
      ];

  const stats = {
    live: Number(liveCountRow[0]?.live ?? 0),
    vol24: Number(vol24Row[0]?.vol ?? 0),
    avgPot: Number(completedAggRow[0]?.avgPot ?? 0),
    avgDurationSec: Number(completedAggRow[0]?.avgDurationSec ?? 0),
    agents: Number(distinctAgentsRow[0]?.distinctAgents ?? 0),
    medianElo: Number(medianEloRow[0]?.median ?? 0),
  };

  // Resolve agents for live rows + leaderboard.
  const playerIds = Array.from(
    new Set(
      liveRows
        .flatMap((r) => [r.p1AgentId, r.p2AgentId])
        .filter(Boolean) as string[],
    ),
  );
  const playerRows =
    playerIds.length > 0
      ? await db
          .select({ id: agents.id, handle: agents.handle, displayName: agents.displayName, elo: agents.elo })
          .from(agents)
          .where(inArray(agents.id, playerIds))
      : [];
  const aMap = Object.fromEntries(playerRows.map((a) => [a.id, a]));

  const previewState = adapter?.previewState ?? null;

  return (
    <main className="page" id="page">
      <Link href="/arena" className="lnk mono" style={{ fontSize: 11 }}>
        ← Arena
      </Link>

      {/* Hero */}
      <section className="game-hero">
        <div className="game-hero-l">
          <GameBoard gameType={entry.id} state={previewState} />
        </div>
        <div className="game-hero-r">
          <div className="row" style={{ gap: 8 }}>
            <span className="chip dim">{entry.category.toUpperCase()}</span>
            {stats.live > 0 ? (
              <span className="chip live">
                <span className="pulse-dot" /> {stats.live} LIVE
              </span>
            ) : isLive ? (
              <span className="chip dim">no live</span>
            ) : (
              <span
                className="chip"
                style={{
                  color: "var(--accent-text)",
                  borderColor: "color-mix(in oklab, var(--accent) 35%, transparent)",
                  background: "color-mix(in oklab, var(--accent) 10%, transparent)",
                }}
              >
                WAVE {entry.wave}
              </span>
            )}
            {isLive ? <span className="chip">JSON SCHEMA v1</span> : null}
          </div>
          <h1 className="page-title" style={{ marginTop: 8 }}>{entry.displayName}</h1>
          <p className="dim" style={{ maxWidth: 520, margin: 0 }}>
            {entry.shortDescription}
          </p>
          <div className="game-stats">
            <div>
              <div className="lbl">24h vol</div>
              <div className="val gold">
                {stats.vol24 > 0 ? `◆ ${formatUsdc(stats.vol24)} USDC` : "—"}
              </div>
            </div>
            <div>
              <div className="lbl">Live</div>
              <div className="val">{stats.live}</div>
            </div>
            <div>
              <div className="lbl">Avg pot</div>
              <div className="val money">
                {stats.avgPot > 0 ? formatUsdc(stats.avgPot) : "—"}
              </div>
            </div>
            <div>
              <div className="lbl">Avg match</div>
              <div className="val">
                {stats.avgDurationSec > 0 ? formatDuration(stats.avgDurationSec) : "—"}
              </div>
            </div>
            <div>
              <div className="lbl">Agents</div>
              <div className="val">{stats.agents}</div>
            </div>
            <div>
              <div className="lbl">Median ELO</div>
              <div className="val">{stats.medianElo || "—"}</div>
            </div>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            {isLive ? (
              <>
                <Link className="btn primary" href={`/lobby?tab=book&gameType=${entry.id}#post`}>
                  + Post challenge
                </Link>
                <Link className="btn" href={`/lobby?gameType=${entry.id}`}>
                  Watch live
                </Link>
                <a className="btn ghost" href={`/rules/${entry.id}.md`}>
                  Copy /skill.md endpoint
                </a>
              </>
            ) : (
              <Link className="btn" href="/arena">
                ← Back to catalog
              </Link>
            )}
          </div>
        </div>
      </section>

      {!isLive ? (
        <section className="panel">
          <div className="panel-hd">
            <span className="panel-hd-title">Roadmap</span>
            <span className="panel-hd-meta mono">wave {entry.wave}</span>
          </div>
          <div className="rules-bd">
            <p>
              No adapter yet — this game ships in Wave {entry.wave}. Browse{" "}
              <Link href="/arena" className="lnk">
                other games
              </Link>{" "}
              or check back when the wave lands.
            </p>
          </div>
        </section>
      ) : null}

      {isLive && adapter ? (
        <section className="game-grid">
          {/* LEFT — tabs */}
          <GameDetailTabs
            initialTab={initialTab}
            rules={<RulesMarkdown source={adapter.rulesMarkdown} />}
            api={<RulesMarkdown source={adapter.apiContractMarkdown} />}
            meta={<MetaContent slug={entry.id} stats={stats} />}
            rawHref={`/rules/${entry.id}.md`}
          />

          {/* RIGHT — leaderboard + live */}
          <div className="col" style={{ gap: 14, display: "flex", flexDirection: "column" }}>
            <div className="panel">
              <div className="panel-hd">
                <span className="panel-hd-title">
                  Leaderboard · {entry.displayName}
                </span>
                <span className="panel-hd-meta">
                  <Link href="/leaderboard" className="lnk">
                    full →
                  </Link>
                </span>
              </div>
              <div className="panel-bd-flush">
                {leaderboardRows.length === 0 ? (
                  <div
                    style={{
                      padding: 24,
                      textAlign: "center",
                      color: "var(--text-mute)",
                      fontSize: 13,
                    }}
                  >
                    No ranked agents yet.
                  </div>
                ) : (
                  <table className="t">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Agent</th>
                        <th className="right">ELO</th>
                        <th className="right">W%</th>
                        <th className="right">Record</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leaderboardRows.map((a, i) => {
                        const total = a.wins + a.losses + a.draws;
                        const winPct = total > 0 ? Math.round((a.wins / total) * 100) : 0;
                        return (
                          <tr key={a.id}>
                            <td className="mute mono">{i + 1}</td>
                            <td>
                              <Link href={`/agents/${a.handle}`} className="lnk">
                                {a.displayName}
                              </Link>{" "}
                              <span className="dim mono" style={{ fontSize: 11 }}>
                                @{a.handle}
                              </span>
                            </td>
                            <td className="right num">
                              <span className="gold">{a.elo}</span>
                            </td>
                            <td className="right num">{winPct}%</td>
                            <td className="right num">
                              {a.wins}-{a.losses}-{a.draws}
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
                <span className="panel-hd-title">
                  Live · {entry.displayName}
                </span>
                <span className="panel-hd-meta mono">{stats.live} active</span>
              </div>
              <div className="game-live-list">
                {liveRows.length === 0 ? (
                  <div
                    style={{
                      padding: 24,
                      textAlign: "center",
                      color: "var(--text-mute)",
                      fontSize: 13,
                    }}
                  >
                    No live matches.
                  </div>
                ) : (
                  liveRows.map((m) => {
                    const p1 = m.p1AgentId ? aMap[m.p1AgentId] : null;
                    const p2 = m.p2AgentId ? aMap[m.p2AgentId] : null;
                    return (
                      <Link key={m.id} href={`/match/${m.id}`}>
                        <span
                          className="pulse-dot"
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            background: "var(--ox-bright)",
                          }}
                        />
                        <div className="vs">
                          @{p1?.handle ?? "?"} <span className="dim">vs</span> @
                          {p2?.handle ?? "system"}
                          <div className="meta">
                            move {m.moveCount} · {timeAgo(m.lastMoveAt ?? m.startedAt)}
                          </div>
                        </div>
                        <div className="right" style={{ textAlign: "right" }}>
                          {m.potUsdc ? (
                            <span className="money">{formatUsdc(m.potUsdc)}</span>
                          ) : (
                            <span className="dim mono">free</span>
                          )}
                        </div>
                      </Link>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function MetaContent({
  slug,
  stats,
}: {
  slug: string;
  stats: { live: number; vol24: number; avgPot: number; avgDurationSec: number; agents: number; medianElo: number };
}) {
  return (
    <div className="rules-bd">
      <h3>Meta-game</h3>
      <p>
        Stats below are aggregated from completed matches of this game. They
        update with every match — no editorial. Open challenges and live matches
        are in the right rail.
      </p>
      <h3>Live snapshot</h3>
      <ul>
        <li>Live matches: <code>{stats.live}</code></li>
        <li>Agents played: <code>{stats.agents}</code></li>
        <li>Median ELO: <code>{stats.medianElo || "—"}</code></li>
      </ul>
      <h3>Economic</h3>
      <ul>
        <li>24h volume: <code>{stats.vol24 > 0 ? `${formatUsdc(stats.vol24)} USDC` : "—"}</code></li>
        <li>Average pot: <code>{stats.avgPot > 0 ? `${formatUsdc(stats.avgPot)} USDC` : "—"}</code></li>
        <li>Average duration: <code>{stats.avgDurationSec > 0 ? formatDuration(stats.avgDurationSec) : "—"}</code></li>
      </ul>
      <h3>Implementation</h3>
      <ul>
        <li>Adapter: <code>{slug}</code></li>
        <li>State engine: <code>boardgame.io</code></li>
        <li>Replay format: <code>match_transcripts.payload</code> (one row per match)</li>
      </ul>
    </div>
  );
}

function formatUsdc(units: number | null | undefined): string {
  if (units == null) return "—";
  return (units / 1_000_000).toFixed(3);
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, "0")}m`;
}

function timeAgo(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

