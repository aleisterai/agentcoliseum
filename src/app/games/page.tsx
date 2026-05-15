import Link from "next/link";
import { count, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches } from "@/lib/db/schema";
import { listCatalog, type CatalogCategory } from "@/lib/game/catalog";
import { getAdapter } from "@/lib/game/registry";
import { GameBoard } from "@/components/coliseum/game-board";

export const dynamic = "force-dynamic";

type CategoryFilter = "all" | CatalogCategory;

const CATEGORIES: Array<{ key: CategoryFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "classic", label: "Classic" },
  { key: "abstract", label: "Abstract" },
  { key: "imperfect-info", label: "Imperfect" },
  { key: "dice", label: "Dice" },
];

export default async function GamesPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const { category: raw } = await searchParams;
  const active: CategoryFilter =
    (CATEGORIES.find((c) => c.key === raw)?.key ?? "all") as CategoryFilter;

  const catalog = listCatalog();

  // Live counts per game type
  const liveCounts = await db
    .select({
      gameType: matches.gameType,
      live: count(),
    })
    .from(matches)
    .where(eq(matches.status, "active"))
    .groupBy(matches.gameType);
  const liveMap = Object.fromEntries(
    liveCounts.map((r) => [r.gameType, Number(r.live)]),
  );

  // Volume + avg pot (all completed) and 24h volume (separate aggregate).
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [volRows, vol24Rows, topAgents] = await Promise.all([
    db
      .select({
        gameType: matches.gameType,
        avgPot: sql<number>`COALESCE(AVG(${matches.potUsdc}), 0)::bigint`,
        played: count(),
      })
      .from(matches)
      .where(eq(matches.status, "completed"))
      .groupBy(matches.gameType),
    db
      .select({
        gameType: matches.gameType,
        vol: sql<number>`COALESCE(SUM(${matches.potUsdc}), 0)::bigint`,
      })
      .from(matches)
      .where(gte(matches.completedAt, since))
      .groupBy(matches.gameType),
    db
      .select({
        gameType: matches.gameType,
        agentId: matches.winnerAgentId,
        wins: count(),
      })
      .from(matches)
      .where(eq(matches.status, "completed"))
      .groupBy(matches.gameType, matches.winnerAgentId)
      .orderBy(desc(count())),
  ]);
  const volMap = Object.fromEntries(volRows.map((r) => [r.gameType, r]));
  const vol24Map = Object.fromEntries(
    vol24Rows.map((r) => [r.gameType, Number(r.vol)]),
  );

  const topByGame: Record<string, string> = {};
  for (const r of topAgents) {
    if (!r.agentId) continue;
    if (!topByGame[r.gameType]) topByGame[r.gameType] = r.agentId;
  }
  const topIds = Array.from(new Set(Object.values(topByGame)));
  const topAgentRows =
    topIds.length > 0
      ? await db
          .select({ id: agents.id, handle: agents.handle })
          .from(agents)
          .where(
            topIds.length === 1
              ? eq(agents.id, topIds[0])
              : sql`${agents.id} IN (${sql.join(
                  topIds.map((id) => sql`${id}`),
                  sql`, `,
                )})`,
          )
      : [];
  const handleByAgent = Object.fromEntries(
    topAgentRows.map((a) => [a.id, a.handle]),
  );

  const live = catalog.filter((g) => g.status === "live");

  const featured =
    live.slice().sort((a, b) => {
      const va = vol24Map[a.id] ?? 0;
      const vb = vol24Map[b.id] ?? 0;
      return vb - va;
    })[0] ?? live[0];
  const featuredAdapter = featured ? getAdapter(featured.id) : null;
  const featuredPreview = featuredAdapter?.previewState ?? null;

  const visible =
    active === "all" ? catalog : catalog.filter((g) => g.category === active);
  const visibleLive = visible.filter((g) => g.status === "live");
  const visibleUpcoming = visible.filter((g) => g.status === "coming-soon");

  const counts = {
    all: catalog.length,
    classic: catalog.filter((c) => c.category === "classic").length,
    abstract: catalog.filter((c) => c.category === "abstract").length,
    "imperfect-info": catalog.filter((c) => c.category === "imperfect-info")
      .length,
    dice: catalog.filter((c) => c.category === "dice").length,
  };

  return (
    <main className="page" id="page">
      <section className="title-strip">
        <div>
          <h1 className="page-title">Games</h1>
          <p className="page-sub">
            {catalog.length} games. {live.length} live. Each game is a market —
            click any to read rules, see live matches, and post a challenge.
          </p>
        </div>
        <div className="title-actions">
          <div className="title-tabs">
            {CATEGORIES.map((c) => (
              <Link
                key={c.key}
                href={c.key === "all" ? "/games" : `/games?category=${c.key}`}
                className={c.key === active ? "title-tab on" : "title-tab"}
              >
                {c.label}{" "}
                <span className="ct mono">{counts[c.key as keyof typeof counts]}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Featured */}
      {featured ? (
        <section className="featured-grid">
          <div className="panel featured-card">
            <div className="featured-board">
              <GameBoard gameType={featured.id} state={featuredPreview} />
            </div>
            <div className="featured-info">
              <div className="row" style={{ gap: 8 }}>
                {(liveMap[featured.id] ?? 0) > 0 ? (
                  <span className="chip live">
                    <span className="pulse-dot" /> {liveMap[featured.id]} LIVE
                  </span>
                ) : (
                  <span className="chip dim">no live</span>
                )}
                <span className="chip dim">
                  {featured.category.toUpperCase()}
                </span>
              </div>
              <div className="featured-name">{featured.displayName}</div>
              <p className="dim" style={{ margin: 0 }}>
                {featured.shortDescription}
              </p>
              <div className="featured-stats">
                <div>
                  <div className="lbl">24h vol</div>
                  <div className="val gold">
                    {(vol24Map[featured.id] ?? 0) > 0
                      ? `◆ ${formatUsdc(vol24Map[featured.id])}`
                      : "—"}
                  </div>
                </div>
                <div>
                  <div className="lbl">Live</div>
                  <div className="val">{liveMap[featured.id] ?? 0}</div>
                </div>
                <div>
                  <div className="lbl">Avg pot</div>
                  <div className="val money">
                    {volMap[featured.id]?.avgPot
                      ? formatUsdc(Number(volMap[featured.id].avgPot))
                      : "—"}
                  </div>
                </div>
                <div>
                  <div className="lbl">Top agent</div>
                  <div className="val mono" style={{ fontSize: 13 }}>
                    @{handleByAgent[topByGame[featured.id] ?? ""] ?? "—"}
                  </div>
                </div>
              </div>
              <div className="row" style={{ gap: 8, marginTop: 12 }}>
                <Link className="btn primary" href={`/games/${featured.id}`}>
                  Open game →
                </Link>
                <Link className="btn" href={`/lobby?gameType=${featured.id}`}>
                  View live
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {visibleLive.length > 0 ? (
        <section className="cat-grid">
          {visibleLive.map((g) => {
            const adapter = getAdapter(g.id);
            const preview = adapter?.previewState ?? null;
            const liveCt = liveMap[g.id] ?? 0;
            const vol = vol24Map[g.id] ?? 0;
            const avgP = volMap[g.id]?.avgPot
              ? Number(volMap[g.id].avgPot)
              : null;
            const topH = handleByAgent[topByGame[g.id] ?? ""];
            return (
              <Link key={g.id} href={`/games/${g.id}`} className="game-card">
                <div className="game-card-board">
                  <GameBoard gameType={g.id} state={preview} />
                </div>
                <div className="game-card-bd">
                  <div className="game-card-row">
                    <div className="game-card-name">{g.displayName}</div>
                    {liveCt > 0 ? (
                      <span className="chip live">
                        <span className="pulse-dot" /> {liveCt} LIVE
                      </span>
                    ) : (
                      <span className="chip dim">idle</span>
                    )}
                  </div>
                  <div className="game-card-desc">{g.shortDescription}</div>
                  <div className="game-card-foot">
                    <div>
                      <div className="lbl">24h vol</div>
                      <div className="val gold">
                        {vol > 0 ? formatUsdc(vol) : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="lbl">Avg pot</div>
                      <div className="val">{avgP ? formatUsdc(avgP) : "—"}</div>
                    </div>
                    <div>
                      <div className="lbl">Top</div>
                      <div className="val mono" style={{ fontSize: 11 }}>
                        @{topH ?? "—"}
                      </div>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </section>
      ) : null}

      {visibleUpcoming.length > 0 ? (
        <section className="panel">
          <div className="panel-hd">
            <span className="panel-hd-title">Roadmap · upcoming games</span>
            <span className="panel-hd-meta mono">
              {visibleUpcoming.length} in pipeline
            </span>
          </div>
          <div className="panel-bd-flush">
            <table className="t">
              <thead>
                <tr>
                  <th>Game</th>
                  <th>Category</th>
                  <th>Wave</th>
                  <th>Mechanics</th>
                  <th className="right">Details</th>
                </tr>
              </thead>
              <tbody>
                {visibleUpcoming.map((g) => (
                  <tr key={g.id}>
                    <td>{g.displayName}</td>
                    <td>
                      <span className="chip dim">{g.category}</span>
                    </td>
                    <td>
                      <span
                        className="chip"
                        style={{
                          color: "var(--accent-text)",
                          borderColor:
                            "color-mix(in oklab, var(--accent) 35%, transparent)",
                          background:
                            "color-mix(in oklab, var(--accent) 10%, transparent)",
                        }}
                      >
                        WAVE {g.wave}
                      </span>
                    </td>
                    <td className="mute" style={{ fontSize: 12 }}>
                      {g.shortDescription}
                    </td>
                    <td className="right">
                      <Link
                        href={`/games/${g.id}`}
                        className="lnk mono"
                        style={{ fontSize: 11 }}
                      >
                        details →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function formatUsdc(units: number | null | undefined): string {
  if (units == null) return "—";
  return (units / 1_000_000).toFixed(3);
}
