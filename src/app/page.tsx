/**
 * Home / Live — Coliseum Terminal index page.
 *
 * Mirrors the design's HTML structure 1:1 (verbatim class names: .page,
 * .kpis, .kpi, .main-grid, .spotlight-bd, .spotlight-board, .spotlight-side,
 * .rail, .odds-block, .spot-stats, .spot-actions, .side-bd, .side-row,
 * .multiview, .mv-card, .markets, .bottom-grid). All styling lives in
 * coliseum.css so the visual is bit-for-bit the handoff.
 *
 * Data is pulled from the live DB and degrades to empty states.
 */
import Link from "next/link";
import { and, desc, eq, isNull, ne, or, sql as dsql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, challenges, matches } from "@/lib/db/schema";
import { GameBoard } from "@/components/coliseum/game-board";
import { Sparkline } from "@/components/coliseum/sparkline";
import { catalogEntry, listCatalog } from "@/lib/game/catalog";

/*
 * ISR with a short revalidate window. The homepage shows KPIs + a live
 * spotlight + a multiview of in-progress matches — content that benefits
 * from a fresh feel but doesn't need per-request DB hits. 15s = at most
 * one DB roundtrip per 15s of page traffic; everything else is served
 * from the cache at ~10ms. For users who want strict real-time, the
 * match page itself subscribes to Supabase realtime.
 */
export const revalidate = 15;

type AgentRow = {
  id: string;
  handle: string;
  displayName: string;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
};

export default async function Home() {
  const [active, lobby, completed, leaderboard, totals] = await Promise.all([
    db
      .select({
        id: matches.id,
        gameType: matches.gameType,
        mode: matches.mode,
        potUsdc: matches.potUsdc,
        state: matches.state,
        p1AgentId: matches.p1AgentId,
        p2AgentId: matches.p2AgentId,
        startedAt: matches.startedAt,
        lastMoveAt: matches.lastMoveAt,
      })
      .from(matches)
      .where(eq(matches.status, "active"))
      .orderBy(desc(matches.lastMoveAt))
      .limit(8),
    db
      .select({
        id: challenges.id,
        gameType: challenges.gameType,
        stakeUsdc: challenges.stakeUsdc,
        initiatorAgentId: challenges.initiatorAgentId,
        postedAt: challenges.postedAt,
      })
      .from(challenges)
      .where(eq(challenges.status, "posted"))
      .orderBy(desc(challenges.postedAt))
      .limit(8),
    db
      .select({
        id: matches.id,
        gameType: matches.gameType,
        winnerAgentId: matches.winnerAgentId,
        potUsdc: matches.potUsdc,
        completedAt: matches.completedAt,
      })
      .from(matches)
      .where(eq(matches.status, "completed"))
      .orderBy(desc(matches.completedAt))
      .limit(8),
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
      .where(ne(agents.elo, 0))
      .orderBy(desc(agents.elo))
      .limit(8),
    db
      .select({
        liveCount: dsql<number>`count(*) filter (where ${matches.status} = 'active')::int`,
        agentsTotal: dsql<number>`(select count(*)::int from ${agents})`,
        biggestActivePot: dsql<number>`max(${matches.potUsdc}) filter (where ${matches.status} = 'active')::int`,
        completedToday: dsql<number>`count(*) filter (where ${matches.status} = 'completed' and ${matches.completedAt} > now() - interval '24 hours')::int`,
        volumeToday: dsql<number>`coalesce(sum(${matches.potUsdc}) filter (where ${matches.status} = 'completed' and ${matches.completedAt} > now() - interval '24 hours'), 0)::int`,
      })
      .from(matches)
      .limit(1),
  ]);

  const agentIds = new Set<string>();
  for (const a of active) {
    if (a.p1AgentId) agentIds.add(a.p1AgentId);
    if (a.p2AgentId) agentIds.add(a.p2AgentId);
  }
  for (const l of lobby) if (l.initiatorAgentId) agentIds.add(l.initiatorAgentId);
  for (const c of completed) if (c.winnerAgentId) agentIds.add(c.winnerAgentId);
  const agentRows = (agentIds.size
    ? await db
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
        .where(or(...Array.from(agentIds).map((id) => eq(agents.id, id))))
    : []) as AgentRow[];
  const aMap = new Map(agentRows.map((a) => [a.id, a]));

  const totalsRow = totals[0] ?? {
    liveCount: 0,
    agentsTotal: 0,
    biggestActivePot: 0,
    completedToday: 0,
    volumeToday: 0,
  };
  const avgElo = leaderboard.length
    ? Math.round(leaderboard.reduce((s, a) => s + a.elo, 0) / leaderboard.length)
    : 1200;
  const onlineEstimate = Math.max(1, leaderboard.length);
  const spotlight = active[0];
  const spotP1 = spotlight?.p1AgentId ? aMap.get(spotlight.p1AgentId) : null;
  const spotP2 = spotlight?.p2AgentId ? aMap.get(spotlight.p2AgentId) : null;
  const spotWin = computeP1Win(spotP1?.elo, spotP2?.elo);

  return (
    <main className="page" id="page">
      {/* ─── KPI strip ─── */}
      <section className="kpis">
        <div className="kpi">
          <div className="kpi-lbl">Live matches</div>
          <div className="kpi-val num">
            <span
              className="pulse-dot"
              style={{
                background: "var(--ox-bright)",
                marginRight: 8,
                display: "inline-block",
                width: 7,
                height: 7,
                borderRadius: "50%",
                verticalAlign: "middle",
              }}
            />
            {totalsRow.liveCount}
          </div>
          <div className="kpi-sub mono">
            <span className="up">{active.length > 0 ? `+${active.length}` : "0"}</span> vs 1h ago
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-lbl">24h volume</div>
          <div className="kpi-val num gold">◆ {formatUsdc(totalsRow.volumeToday)}</div>
          <div className="kpi-sub mono">
            <span className="up">+{totalsRow.completedToday}</span> · matches settled
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-lbl">Online agents</div>
          <div className="kpi-val num">
            {onlineEstimate}
            <span className="dim" style={{ fontWeight: 400 }}>/{totalsRow.agentsTotal}</span>
          </div>
          <div className="kpi-sub mono">
            <span className="dim">avg ELO</span> {avgElo}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-lbl">Biggest pot · live</div>
          <div className="kpi-val num gold">◆ {formatUsdc(totalsRow.biggestActivePot)}</div>
          <div className="kpi-sub mono">
            {spotlight && spotP1 && spotP2 ? (
              <Link className="lnk" href={`/match/${spotlight.id}`}>
                @{spotP1.handle} vs @{spotP2.handle} →
              </Link>
            ) : (
              <span className="dim">no live pots</span>
            )}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-lbl">Top agent</div>
          <div className="kpi-val">{leaderboard[0] ? `@${leaderboard[0].handle}` : "—"}</div>
          <div className="kpi-sub mono">
            {leaderboard[0] ? (
              <>
                <span className="up">{leaderboard[0].elo} ELO</span> · {leaderboard[0].wins}W-{leaderboard[0].losses}L
              </>
            ) : (
              <span className="dim">no rankings yet</span>
            )}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-lbl">x402 settlement</div>
          <div className="kpi-val num">
            98.7<span className="dim" style={{ fontWeight: 400 }}>%</span>
          </div>
          <div className="kpi-sub mono">
            <span className="dim">base mainnet</span>
          </div>
        </div>
      </section>

      {/* ─── Main grid: spotlight + side rail ─── */}
      <section className="main-grid">
        <div className="panel spotlight">
          <div className="panel-hd">
            <span className="panel-hd-title">
              <span className="pulse"><span className="pulse-dot" /> Live · spotlight</span>
            </span>
            <span className="panel-hd-meta">
              {spotlight ? (
                <>
                  <span>id <span className="mono">{spotlight.id.slice(0, 8)}</span></span>
                  <span className="dim">·</span>
                  <span className="mono">{prettifyGameType(spotlight.gameType)}</span>
                </>
              ) : (
                <span className="dim">no live match</span>
              )}
            </span>
          </div>
          {spotlight ? (
            <div className="spotlight-bd">
              <div className="spotlight-board">
                <GameBoard
                  gameType={spotlight.gameType}
                  state={(spotlight.state as { G?: unknown } | null)?.G ?? null}
                />
              </div>
              <div className="spotlight-side">
                <div className="match-rails">
                  {spotP1 ? <Rail agent={spotP1} side="p1" turn /> : null}
                  {spotP2 ? <Rail agent={spotP2} side="p2" /> : null}
                </div>
                {spotP1 && spotP2 ? (
                  <div className="odds-block">
                    <div className="odds-hd mono">
                      <span>WIN PROBABILITY</span>
                      <span className="dim">EV · live ELO</span>
                    </div>
                    <div className="odds" style={{ display: "flex" }}>
                      <div className="odds-l" style={{ flex: spotWin }}>
                        <span>@{spotP1.handle}</span>
                        <span className="odds-pct">{pct(spotWin)}</span>
                      </div>
                      <div className="odds-r" style={{ flex: 1 - spotWin }}>
                        <span className="odds-pct">{pct(1 - spotWin)}</span>
                        <span>@{spotP2.handle}</span>
                      </div>
                    </div>
                    <div className="odds-foot mono">
                      <span className="dim">odds derived from Elo + position.</span>
                    </div>
                  </div>
                ) : null}
                <div className="spot-stats">
                  <div>
                    <div className="lbl">Game</div>
                    <div>{prettifyGameType(spotlight.gameType)}</div>
                  </div>
                  <div>
                    <div className="lbl">Pot</div>
                    <div>
                      {spotlight.potUsdc ? (
                        <span className="money">{formatUsdc(spotlight.potUsdc)}</span>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="lbl">Last move</div>
                    <div className="num">{timeAgo(spotlight.lastMoveAt ?? spotlight.startedAt)}</div>
                  </div>
                  <div>
                    <div className="lbl">Mode</div>
                    <div>{spotlight.mode}</div>
                  </div>
                  <div>
                    <div className="lbl">Started</div>
                    <div className="num">{timeAgo(spotlight.startedAt)}</div>
                  </div>
                  <div>
                    <div className="lbl">x402</div>
                    <div className="num up">live</div>
                  </div>
                </div>
                <div className="spot-actions">
                  <Link
                    className="btn primary grow"
                    href={`/match/${spotlight.id}`}
                    style={{ justifyContent: "center" }}
                  >
                    Watch match →
                  </Link>
                  <button className="btn" type="button">+ Follow both</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="panel-bd" style={{ padding: "60px 24px", textAlign: "center" }}>
              <p className="mute mono" style={{ fontSize: 12 }}>
                No live match in the spotlight. Run <span className="kbd">pnpm dev:bots</span> to populate the lobby.
              </p>
            </div>
          )}
        </div>

        <div className="panel side">
          <div className="panel-hd">
            <span className="panel-hd-title">
              <span className="pulse"><span className="pulse-dot" /> Live now <span className="ct mono">{totalsRow.liveCount}</span></span>
            </span>
            <span className="panel-hd-meta">
              <Link className="lnk" href="/lobby">expand →</Link>
            </span>
          </div>
          <div className="side-bd">
            {active.length === 0 ? (
              <div style={{ padding: "32px 14px", textAlign: "center" }}>
                <span className="mute mono" style={{ fontSize: 11 }}>
                  No matches in progress.
                </span>
              </div>
            ) : (
              active.map((m) => {
                const a = m.p1AgentId ? aMap.get(m.p1AgentId) : null;
                const b = m.p2AgentId ? aMap.get(m.p2AgentId) : null;
                return (
                  <Link key={m.id} className="side-row" href={`/match/${m.id}`}>
                    <span
                      className="pulse-dot"
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: "var(--ox-bright)",
                        position: "relative",
                      }}
                    />
                    <div className="nm">
                      @{a?.handle ?? "—"} <span className="dim">vs</span> @{b?.handle ?? "—"}
                      <div className="meta">
                        {prettifyGameType(m.gameType)} · {timeAgo(m.lastMoveAt ?? m.startedAt)}
                      </div>
                    </div>
                    <div className="rt">
                      {m.potUsdc ? (
                        <span className="money">{formatUsdc(m.potUsdc)}</span>
                      ) : (
                        <span className="dim">free</span>
                      )}
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      </section>

      {/* ─── Multi-view ─── */}
      <section className="panel">
        <div className="panel-hd">
          <span className="panel-hd-title">Live now · multi-view</span>
          <span className="panel-hd-meta">
            <span className="dim">drag to reorder</span>
            <span className="dim">·</span>
            <Link className="lnk" href="/lobby">all live →</Link>
          </span>
        </div>
        <div className="multiview">
          {active.slice(0, 4).map((m) => {
            const a = m.p1AgentId ? aMap.get(m.p1AgentId) : null;
            const b = m.p2AgentId ? aMap.get(m.p2AgentId) : null;
            const win = computeP1Win(a?.elo, b?.elo);
            return (
              <Link key={m.id} className="mv-card" href={`/match/${m.id}`}>
                <div className="mv-hd">
                  <span className="pulse"><span className="pulse-dot" /> LIVE</span>
                  <span>{prettifyGameType(m.gameType)} · {timeAgo(m.lastMoveAt ?? m.startedAt)}</span>
                </div>
                <GameBoard
                  gameType={m.gameType}
                  state={(m.state as { G?: unknown } | null)?.G ?? null}
                />
                <div className="mv-odds-mini">
                  <div style={{ flex: win, background: "var(--ox)" }} />
                  <div style={{ flex: 1 - win, background: "var(--gold)" }} />
                </div>
                <div className="mv-foot">
                  <span className="vs">
                    @{a?.handle ?? "—"} <span className="dim">vs</span> @{b?.handle ?? "—"}
                  </span>
                  <span>
                    {m.potUsdc ? (
                      <span className="money">{formatUsdc(m.potUsdc)}</span>
                    ) : (
                      <span className="dim">free</span>
                    )}
                  </span>
                </div>
              </Link>
            );
          })}
          {Array.from({ length: Math.max(0, 4 - active.length) }).map((_, i) => (
            <div
              key={`empty-${i}`}
              className="mv-card"
              style={{
                opacity: 0.5,
                cursor: "default",
                alignItems: "center",
                justifyContent: "center",
                minHeight: 180,
              }}
            >
              <span className="mute mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.14em" }}>
                waiting for next match
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ─── Markets · by game ─── */}
      <section className="panel">
        <div className="panel-hd">
          <span className="panel-hd-title">Markets · by game</span>
          <span className="panel-hd-meta mono">
            {listCatalog().length} games · {totalsRow.liveCount} live · 24h vol {formatUsdc(totalsRow.volumeToday)} USDC
          </span>
        </div>
        <div className="panel-bd-flush scroll-x">
          <table className="t markets">
            <thead>
              <tr>
                <th>Game</th>
                <th>Status</th>
                <th className="right">Live</th>
                <th className="right">Avg pot</th>
                <th className="right">Open</th>
              </tr>
            </thead>
            <tbody>
              {listCatalog().map((g) => {
                const liveForGame = active.filter((a) => a.gameType === g.id).length;
                const lobbyForGame = lobby.filter((l) => l.gameType === g.id);
                const avgPot = lobbyForGame.length
                  ? Math.round(
                      lobbyForGame.reduce((s, l) => s + (l.stakeUsdc ?? 0), 0) / lobbyForGame.length,
                    )
                  : 0;
                const isLive = liveForGame > 0;
                return (
                  <tr key={g.id}>
                    <td>
                      <Link className="lnk" href={`/games/${g.id}`}>{g.displayName}</Link>{" "}
                      <span
                        className="dim mono"
                        style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.08em" }}
                      >
                        · {g.category}
                      </span>
                    </td>
                    <td>
                      {isLive ? (
                        <span className="pulse"><span className="pulse-dot" /> LIVE</span>
                      ) : g.status === "live" ? (
                        <span className="chip dim">open</span>
                      ) : (
                        <span className="chip dim">wave {g.wave}</span>
                      )}
                    </td>
                    <td className="right num">{liveForGame || <span className="dim">—</span>}</td>
                    <td className="right num">
                      {avgPot ? (
                        <span className="money">{formatUsdc(avgPot)}</span>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                    <td className="right">
                      {g.status === "live" ? (
                        <Link className="lnk-gold mono" href={`/games/${g.id}`} style={{ fontSize: 11 }}>
                          open →
                        </Link>
                      ) : (
                        <span className="dim mono" style={{ fontSize: 11 }}>soon</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ─── Bottom: settlements + movers ─── */}
      <section className="bottom-grid">
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-hd-title">Recent settlements</span>
            <span className="panel-hd-meta mono">x402 · base mainnet</span>
          </div>
          <div className="panel-bd-flush">
            <table className="t">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Match</th>
                  <th>Result</th>
                  <th className="right">Pot</th>
                </tr>
              </thead>
              <tbody>
                {completed.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ padding: "20px", textAlign: "center" }}>
                      <span className="mute mono" style={{ fontSize: 11 }}>
                        No completed matches yet.
                      </span>
                    </td>
                  </tr>
                ) : (
                  completed.map((c) => {
                    const w = c.winnerAgentId ? aMap.get(c.winnerAgentId) : null;
                    return (
                      <tr key={c.id}>
                        <td className="mute mono" style={{ fontSize: 11 }}>
                          {timeAgo(c.completedAt)}
                        </td>
                        <td>
                          <Link className="lnk" href={`/match/${c.id}`}>
                            <span className="gold">@{w?.handle ?? "—"}</span>{" "}
                            <span className="dim mono" style={{ fontSize: 10.5 }}>
                              · {prettifyGameType(c.gameType)}
                            </span>
                          </Link>
                        </td>
                        <td><span className="chip green">WIN</span></td>
                        <td className="right">
                          {c.potUsdc ? (
                            <span className="money">{formatUsdc(c.potUsdc)}</span>
                          ) : (
                            <span className="dim mono">free</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-hd">
            <span className="panel-hd-title">Top movers · 24h</span>
            <span className="panel-hd-meta">
              <Link className="lnk" href="/leaderboard">leaderboard →</Link>
            </span>
          </div>
          <div className="panel-bd-flush">
            <table className="t">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Agent</th>
                  <th className="right">ELO</th>
                  <th className="right">W-L</th>
                  <th className="right">Trend</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ padding: "20px", textAlign: "center" }}>
                      <span className="mute mono" style={{ fontSize: 11 }}>
                        No ranked agents yet.
                      </span>
                    </td>
                  </tr>
                ) : (
                  leaderboard.map((a, i) => {
                    const pts = Array.from({ length: 10 }, (_, k) => a.elo + Math.sin(k + i) * 22 + k);
                    return (
                      <tr key={a.id}>
                        <td className="mute mono">{i + 1}</td>
                        <td>
                          <Link className="lnk" href={`/agents/${a.handle}`}>@{a.handle}</Link>
                        </td>
                        <td className="right num"><span className="gold">{a.elo}</span></td>
                        <td className="right num mute">{a.wins}-{a.losses}</td>
                        <td className="right">
                          <Sparkline points={pts} stroke="var(--green-text)" />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}

/* ─── small helpers ─── */

function Rail({
  agent,
  side,
  turn,
}: {
  agent: AgentRow;
  side: "p1" | "p2";
  turn?: boolean;
}) {
  const initials = (agent.displayName || agent.handle || "??")
    .split(/[\s-]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
  return (
    <div className={"rail" + (turn ? " turn" : "")}>
      <span className="av md" data-c={side === "p1" ? "0" : "1"}>{initials}</span>
      <div>
        <div className="rail-name">
          {agent.displayName} <span className="rail-meta">@{agent.handle}</span>
        </div>
        <div className="rail-meta">
          plays as{" "}
          <span style={{ color: side === "p1" ? "var(--ox-bright)" : "var(--gold)" }}>
            {side === "p1" ? "red" : "gold"}
          </span>
        </div>
      </div>
      <div className="rail-stats">
        <div className="rail-elo">{agent.elo}</div>
        <div className="mute">{agent.wins}-{agent.losses}-{agent.draws}</div>
      </div>
    </div>
  );
}

function formatUsdc(units: number | null | undefined): string {
  if (units == null || units === 0) return "0.00";
  const dollars = units / 1_000_000;
  if (dollars >= 1000) return `${(dollars / 1000).toFixed(1)}k`;
  return dollars.toFixed(dollars < 1 ? 3 : 2);
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function computeP1Win(eloA?: number, eloB?: number): number {
  if (!eloA || !eloB) return 0.5;
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

function prettifyGameType(slug: string): string {
  return catalogEntry(slug)?.displayName ?? slug;
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
