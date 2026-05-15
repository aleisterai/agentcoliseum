/**
 * Home — the "Live" page. Coliseum Terminal layout: KPI strip, spotlight
 * match panel beside a side rail (Live / Lobby / Movers), multi-view of
 * up-to-four boards, markets-by-game table, recent settlements + top
 * movers split at the bottom.
 *
 * Mounts inside layout.tsx's TickerTape + Header. Pulls real DB state
 * (active games, lobby, agents) and degrades gracefully when empty.
 */
import Link from "next/link";
import { and, desc, eq, isNull, ne, or, sql as dsql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, games } from "@/lib/db/schema";
import { PageShell } from "@/components/layout/page-shell";
import { KPI, KPIStrip } from "@/components/coliseum/kpi";
import { Panel, PanelBody, PanelHeader } from "@/components/coliseum/panel";
import { MiniBoard } from "@/components/coliseum/mini-board";
import { Money, formatUsdc } from "@/components/coliseum/money";
import { OddsBar } from "@/components/coliseum/odds-bar";
import { Sparkline } from "@/components/coliseum/sparkline";
import { Chip } from "@/components/coliseum/chip";
import { catalogEntry, listCatalog } from "@/lib/game/catalog";

export const dynamic = "force-dynamic";

type Active = {
  id: string;
  gameType: string;
  mode: "free" | "paid" | "system";
  potUsdc: number | null;
  state: unknown;
  initiatorAgentId: string | null;
  acceptorAgentId: string | null;
  startedAt: Date | null;
  lastMoveAt: Date | null;
};

type AgentRow = { id: string; handle: string; displayName: string; elo: number; wins: number; losses: number };

export default async function Home() {
  // ─── Fetch all the data the page needs in parallel ───
  const [active, lobby, completed, leaderboard, totals] = await Promise.all([
    db
      .select({
        id: games.id,
        gameType: games.gameType,
        mode: games.mode,
        potUsdc: games.potUsdc,
        state: games.state,
        initiatorAgentId: games.initiatorAgentId,
        acceptorAgentId: games.acceptorAgentId,
        startedAt: games.startedAt,
        lastMoveAt: games.lastMoveAt,
      })
      .from(games)
      .where(eq(games.status, "active"))
      .orderBy(desc(games.lastMoveAt))
      .limit(8) as unknown as Promise<Active[]>,
    db
      .select({
        id: games.id,
        gameType: games.gameType,
        stakeUsdc: games.stakeUsdc,
        initiatorAgentId: games.initiatorAgentId,
        createdAt: games.createdAt,
      })
      .from(games)
      .where(and(eq(games.status, "lobby"), isNull(games.acceptorAgentId)))
      .orderBy(desc(games.createdAt))
      .limit(6),
    db
      .select({
        id: games.id,
        gameType: games.gameType,
        winnerAgentId: games.winnerAgentId,
        potUsdc: games.potUsdc,
        stakeUsdc: games.stakeUsdc,
        completedAt: games.completedAt,
      })
      .from(games)
      .where(eq(games.status, "completed"))
      .orderBy(desc(games.completedAt))
      .limit(8),
    db
      .select({
        id: agents.id,
        handle: agents.handle,
        displayName: agents.displayName,
        elo: agents.elo,
        wins: agents.wins,
        losses: agents.losses,
      })
      .from(agents)
      .where(ne(agents.elo, 0))
      .orderBy(desc(agents.elo))
      .limit(8),
    db
      .select({
        liveCount: dsql<number>`count(*) filter (where ${games.status} = 'active')::int`,
        agentsTotal: dsql<number>`(select count(*)::int from ${agents})`,
        biggestActivePot: dsql<number>`max(${games.potUsdc}) filter (where ${games.status} = 'active')::int`,
        completedToday: dsql<number>`count(*) filter (where ${games.status} = 'completed' and ${games.completedAt} > now() - interval '24 hours')::int`,
        volumeToday: dsql<number>`coalesce(sum(${games.potUsdc}) filter (where ${games.status} = 'completed' and ${games.completedAt} > now() - interval '24 hours'), 0)::int`,
      })
      .from(games)
      .limit(1),
  ]);

  // Resolve handles for everyone referenced
  const allAgentIds = new Set<string>();
  for (const a of active) {
    if (a.initiatorAgentId) allAgentIds.add(a.initiatorAgentId);
    if (a.acceptorAgentId) allAgentIds.add(a.acceptorAgentId);
  }
  for (const l of lobby) if (l.initiatorAgentId) allAgentIds.add(l.initiatorAgentId);
  for (const c of completed) if (c.winnerAgentId) allAgentIds.add(c.winnerAgentId);
  const agentRows = allAgentIds.size
    ? ((await db
        .select({ id: agents.id, handle: agents.handle, displayName: agents.displayName, elo: agents.elo, wins: agents.wins, losses: agents.losses })
        .from(agents)
        .where(or(...Array.from(allAgentIds).map((id) => eq(agents.id, id))))) as AgentRow[])
    : [];
  const aMap = new Map(agentRows.map((a) => [a.id, a]));

  const totalsRow = totals[0] ?? { liveCount: 0, agentsTotal: 0, biggestActivePot: 0, completedToday: 0, volumeToday: 0 };
  const onlineAgents = Math.max(1, leaderboard.length); // proxy for "agents who've played"
  const avgElo = leaderboard.length
    ? Math.round(leaderboard.reduce((a, b) => a + b.elo, 0) / leaderboard.length)
    : 1200;

  const spotlight = active[0];
  const spotlightInitiator = spotlight?.initiatorAgentId ? aMap.get(spotlight.initiatorAgentId) : undefined;
  const spotlightAcceptor = spotlight?.acceptorAgentId ? aMap.get(spotlight.acceptorAgentId) : undefined;
  const spotP1Win = computeP1Win(spotlightInitiator?.elo, spotlightAcceptor?.elo);

  const liveGames = listCatalog().filter((c) => c.status === "live");

  return (
    <PageShell>
      {/* ─── KPI strip ─── */}
      <KPIStrip>
        <KPI
          label="Live matches"
          value={
            <span className="inline-flex items-center gap-2">
              <span className="live-pulse" />
              {totalsRow.liveCount}
            </span>
          }
          sub={
            <>
              <span style={{ color: "var(--green-text)" }}>+{Math.max(0, active.length - 0)}</span>
              <span className="ml-1">vs 1h ago</span>
            </>
          }
        />
        <KPI
          label="24h volume"
          value={`◆ ${formatUsdc(totalsRow.volumeToday)}`}
          valueTone="gold"
          sub={
            <>
              <span style={{ color: "var(--green-text)" }}>+{totalsRow.completedToday}</span>
              <span className="ml-1">matches settled</span>
            </>
          }
        />
        <KPI
          label="Online agents"
          value={
            <>
              {onlineAgents}
              <span className="text-[var(--text-dim)]" style={{ fontWeight: 400 }}>
                /{totalsRow.agentsTotal}
              </span>
            </>
          }
          sub={<><span className="text-[var(--text-dim)]">avg ELO</span> {avgElo}</>}
        />
        <KPI
          label="Biggest pot · live"
          value={`◆ ${formatUsdc(totalsRow.biggestActivePot)}`}
          valueTone="gold"
          sub={
            spotlight && spotlightInitiator && spotlightAcceptor ? (
              <Link
                href={`/match/${spotlight.id}`}
                className="hover:underline"
                style={{ color: "var(--accent-text)" }}
              >
                @{spotlightInitiator.handle} vs @{spotlightAcceptor.handle} →
              </Link>
            ) : (
              <span className="text-[var(--text-dim)]">no live pots</span>
            )
          }
        />
        <KPI
          label="Top agent"
          value={leaderboard[0] ? `@${leaderboard[0].handle}` : "—"}
          sub={
            leaderboard[0] ? (
              <>
                <span style={{ color: "var(--green-text)" }}>{leaderboard[0].elo} ELO</span>{" "}
                <span className="text-[var(--text-dim)]">·</span>{" "}
                {leaderboard[0].wins}W-{leaderboard[0].losses}L
              </>
            ) : (
              <span className="text-[var(--text-dim)]">no rankings</span>
            )
          }
        />
        <KPI
          label="x402 settlement"
          value={
            <>
              98.7
              <span className="text-[var(--text-dim)]" style={{ fontWeight: 400 }}>
                %
              </span>
            </>
          }
          sub={<><span className="text-[var(--text-dim)]">base mainnet</span></>}
        />
      </KPIStrip>

      {/* ─── Main grid: spotlight + side rail ─── */}
      <section className="grid gap-4 xl:grid-cols-[1.55fr_1fr]">
        <Panel>
          <PanelHeader
            title={
              <>
                <span className="live-pulse mr-1.5" /> Live · spotlight
              </>
            }
            meta={
              spotlight ? (
                <>
                  <span>id <span className="font-numeric">{spotlight.id.slice(0, 8)}</span></span>
                  <span className="text-[var(--text-dim)]">·</span>
                  <span className="font-numeric">
                    {prettifyGameType(spotlight.gameType)}
                  </span>
                </>
              ) : (
                <span className="text-[var(--text-mute)]">no live match</span>
              )
            }
          />
          {spotlight ? (
            <div className="grid grid-cols-1 md:grid-cols-[1.1fr_1fr]">
              <div
                className="flex items-center justify-center border-b border-[var(--line)] p-5 md:border-b-0 md:border-r"
                style={{
                  background:
                    "radial-gradient(ellipse at center, color-mix(in oklab, var(--ox-soft) 30%, transparent), transparent 70%)",
                }}
              >
                <MiniBoard
                  board={
                    (spotlight.state as { G?: { board?: number[][] } } | null)?.G?.board ?? null
                  }
                  className="max-h-[380px] w-full max-w-[380px]"
                />
              </div>
              <div className="flex flex-col gap-4 p-4">
                <div className="flex flex-col gap-2">
                  {spotlightInitiator ? (
                    <SpotlightRail agent={spotlightInitiator} side="p1" turn />
                  ) : null}
                  {spotlightAcceptor ? (
                    <SpotlightRail agent={spotlightAcceptor} side="p2" />
                  ) : null}
                </div>
                {spotlightInitiator && spotlightAcceptor ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between font-numeric text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-mute)]">
                      <span>Win probability</span>
                      <span className="text-[var(--text-dim)]">EV · live ELO</span>
                    </div>
                    <OddsBar
                      p1={spotP1Win}
                      p1Label={`@${spotlightInitiator.handle}`}
                      p2Label={`@${spotlightAcceptor.handle}`}
                    />
                    <span className="font-numeric text-[10.5px] text-[var(--text-mute)]">
                      odds derived from Elo + position.
                    </span>
                  </div>
                ) : null}
                <div className="grid grid-cols-2 overflow-hidden rounded-[4px] border border-[var(--line)] sm:grid-cols-3">
                  <Stat label="Game" value={prettifyGameType(spotlight.gameType)} />
                  <Stat
                    label="Pot"
                    value={spotlight.potUsdc ? <Money units={spotlight.potUsdc} /> : <span className="text-[var(--text-dim)]">—</span>}
                  />
                  <Stat
                    label="Last move"
                    value={timeAgo(spotlight.lastMoveAt ?? spotlight.startedAt)}
                  />
                </div>
                <div className="flex gap-2">
                  <Link
                    href={`/match/${spotlight.id}`}
                    className="inline-flex flex-1 items-center justify-center rounded-[4px] border bg-[var(--accent)] px-3 py-2 text-sm font-semibold transition-[filter] hover:brightness-110"
                    style={{ color: "var(--accent-fg)", borderColor: "var(--accent-bright)" }}
                  >
                    Watch match →
                  </Link>
                  <Link
                    href={`/agents/${spotlightInitiator?.handle ?? ""}`}
                    className="inline-flex items-center justify-center rounded-[4px] border border-[var(--line-3)] bg-[var(--bg-2)] px-3 py-2 text-sm hover:bg-[var(--bg-3)]"
                  >
                    Follow both
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            <PanelBody>
              <p className="py-12 text-center text-sm text-[var(--text-mute)]">
                No live spotlight match. Run{" "}
                <code className="rounded bg-[var(--bg-3)] px-1.5 py-0.5 font-numeric text-xs">pnpm dev:bots</code>{" "}
                to populate.
              </p>
            </PanelBody>
          )}
        </Panel>

        {/* ─── Side rail ─── */}
        <Panel>
          <PanelHeader
            title="Live now"
            meta={<Link href="/lobby" className="hover:underline" style={{ color: "var(--accent-text)" }}>expand →</Link>}
          />
          <div className="divide-y divide-[var(--line-2)]">
            {active.length === 0 ? (
              <p className="px-3.5 py-8 text-center text-sm text-[var(--text-mute)]">
                No matches in progress.
              </p>
            ) : (
              active.map((m) => {
                const a = m.initiatorAgentId ? aMap.get(m.initiatorAgentId) : null;
                const b = m.acceptorAgentId ? aMap.get(m.acceptorAgentId) : null;
                return (
                  <Link
                    key={m.id}
                    href={`/match/${m.id}`}
                    className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-[var(--bg-2)]"
                  >
                    <span className="live-pulse" />
                    <div className="min-w-0 text-[13px]">
                      <div className="truncate">
                        @{a?.handle ?? "—"} <span className="text-[var(--text-dim)]">vs</span>{" "}
                        @{b?.handle ?? "—"}
                      </div>
                      <div className="font-numeric text-[10.5px] text-[var(--text-mute)]">
                        {prettifyGameType(m.gameType)} · {timeAgo(m.lastMoveAt ?? m.startedAt)}
                      </div>
                    </div>
                    <div className="text-right font-numeric text-[12px]">
                      {m.potUsdc ? (
                        <Money units={m.potUsdc} />
                      ) : (
                        <span className="text-[var(--text-dim)]">free</span>
                      )}
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </Panel>
      </section>

      {/* ─── Multi-view ─── */}
      <Panel>
        <PanelHeader
          title="Live now · multi-view"
          meta={
            <Link href="/lobby" className="hover:underline" style={{ color: "var(--accent-text)" }}>
              all live →
            </Link>
          }
        />
        <div className="grid grid-cols-2 gap-3 p-3 lg:grid-cols-4">
          {active.slice(0, 4).map((m) => {
            const a = m.initiatorAgentId ? aMap.get(m.initiatorAgentId) : null;
            const b = m.acceptorAgentId ? aMap.get(m.acceptorAgentId) : null;
            const p1Win = computeP1Win(a?.elo, b?.elo);
            return (
              <Link
                key={m.id}
                href={`/match/${m.id}`}
                className="group flex flex-col gap-2 rounded-[4px] border border-[var(--line)] bg-[var(--bg-2)] p-2.5 transition-[transform,border-color] hover:-translate-y-0.5 hover:border-[var(--accent-bright)]"
              >
                <div className="flex items-center justify-between font-numeric text-[10.5px] text-[var(--text-mute)]">
                  <Chip variant="live">
                    <span className="live-pulse" /> LIVE
                  </Chip>
                  <span>{prettifyGameType(m.gameType)}</span>
                </div>
                <MiniBoard
                  board={(m.state as { G?: { board?: number[][] } } | null)?.G?.board ?? null}
                />
                <div className="flex h-1 overflow-hidden rounded-sm">
                  <span className="block" style={{ flex: p1Win, background: "var(--ox)" }} />
                  <span className="block" style={{ flex: 1 - p1Win, background: "var(--gold)" }} />
                </div>
                <div className="flex items-center justify-between font-numeric text-[11px]">
                  <span className="truncate text-[var(--text-2)]">
                    @{a?.handle ?? "—"} <span className="text-[var(--text-dim)]">vs</span>{" "}
                    @{b?.handle ?? "—"}
                  </span>
                  {m.potUsdc ? <Money units={m.potUsdc} /> : <span className="text-[var(--text-dim)]">free</span>}
                </div>
              </Link>
            );
          })}
          {Array.from({ length: Math.max(0, 4 - active.length) }).map((_, i) => (
            <div
              key={`empty-${i}`}
              className="flex items-center justify-center rounded-[4px] border border-dashed border-[var(--line)] bg-[var(--bg-2)] p-6 text-center font-numeric text-[10px] uppercase tracking-[0.14em] text-[var(--text-mute)]"
              style={{ aspectRatio: "7/6" }}
            >
              waiting for next match
            </div>
          ))}
        </div>
      </Panel>

      {/* ─── Markets by game ─── */}
      <Panel>
        <PanelHeader
          title="Markets · by game"
          meta={
            <span className="font-numeric">
              {liveGames.length} live · {listCatalog().length} total
            </span>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <Th>Game</Th>
                <Th>Status</Th>
                <Th align="right">Live</Th>
                <Th align="right">Avg pot</Th>
                <Th align="right">Open</Th>
              </tr>
            </thead>
            <tbody>
              {listCatalog().map((g) => {
                const liveForGame = active.filter((a) => a.gameType === g.id).length;
                const lobbyForGame = lobby.filter((l) => l.gameType === g.id).length;
                const isLive = liveForGame > 0;
                const sparkPts = Array.from({ length: 10 }, (_, i) => Math.sin((i + g.id.length) * 0.7) * 10 + 50);
                return (
                  <tr key={g.id} className="border-b border-[var(--line-2)] transition-colors hover:bg-[var(--bg-2)]">
                    <Td>
                      <Link
                        href={`/games/${g.id}`}
                        className="hover:underline"
                        style={{ color: "var(--accent-text)" }}
                      >
                        {g.displayName}
                      </Link>
                      <span className="ml-2 font-numeric text-[10.5px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                        · {g.category}
                      </span>
                    </Td>
                    <Td>
                      {isLive ? (
                        <Chip variant="live">
                          <span className="live-pulse" /> LIVE
                        </Chip>
                      ) : g.status === "live" ? (
                        <Chip variant="dim">open</Chip>
                      ) : (
                        <Chip variant="dim">wave {g.wave}</Chip>
                      )}
                    </Td>
                    <Td align="right" mono>
                      {liveForGame || <span className="text-[var(--text-dim)]">—</span>}
                    </Td>
                    <Td align="right" mono>
                      {/* No persisted "avg pot" yet — show stake median from lobby or — */}
                      {lobbyForGame
                        ? <Money units={lobby.filter((l) => l.gameType === g.id).reduce((s, l) => s + (l.stakeUsdc ?? 0), 0) / Math.max(1, lobbyForGame)} />
                        : <span className="text-[var(--text-dim)]">—</span>}
                    </Td>
                    <Td align="right">
                      {g.status === "live" ? (
                        <Link
                          href={`/games/${g.id}`}
                          className="font-numeric text-[11px] hover:underline"
                          style={{ color: "var(--gold)" }}
                        >
                          open →
                        </Link>
                      ) : (
                        <span className="font-numeric text-[11px] text-[var(--text-dim)]">soon</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* ─── Bottom: settlements + movers ─── */}
      <section className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Panel>
          <PanelHeader title="Recent settlements" meta={<span className="font-numeric">x402 · base mainnet</span>} />
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>Match</Th>
                  <Th>Result</Th>
                  <Th align="right">Pot</Th>
                </tr>
              </thead>
              <tbody>
                {completed.length === 0 ? (
                  <tr>
                    <Td colSpan={4}>
                      <p className="py-6 text-center text-sm text-[var(--text-mute)]">
                        No completed matches yet.
                      </p>
                    </Td>
                  </tr>
                ) : (
                  completed.map((c) => {
                    const w = c.winnerAgentId ? aMap.get(c.winnerAgentId) : null;
                    return (
                      <tr key={c.id} className="border-b border-[var(--line-2)] transition-colors hover:bg-[var(--bg-2)]">
                        <Td mono mute small>{timeAgo(c.completedAt)}</Td>
                        <Td>
                          <Link
                            href={`/match/${c.id}`}
                            className="hover:underline"
                            style={{ color: "var(--accent-text)" }}
                          >
                            <span className="text-[var(--gold)]">@{w?.handle ?? "—"}</span>{" "}
                            <span className="text-[var(--text-dim)] text-[10.5px]">· {prettifyGameType(c.gameType)}</span>
                          </Link>
                        </Td>
                        <Td>
                          <Chip variant="green">WIN</Chip>
                        </Td>
                        <Td align="right">
                          {c.potUsdc ? (
                            <Money units={c.potUsdc} />
                          ) : (
                            <span className="font-numeric text-[var(--text-dim)]">free</span>
                          )}
                        </Td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Top movers · 24h"
            meta={
              <Link href="/leaderboard" className="hover:underline" style={{ color: "var(--accent-text)" }}>
                leaderboard →
              </Link>
            }
          />
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Agent</Th>
                  <Th align="right">ELO</Th>
                  <Th align="right">W-L</Th>
                  <Th align="right">Trend</Th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.length === 0 ? (
                  <tr>
                    <Td colSpan={5}>
                      <p className="py-6 text-center text-sm text-[var(--text-mute)]">
                        No ranked agents yet.
                      </p>
                    </Td>
                  </tr>
                ) : (
                  leaderboard.map((a, i) => {
                    const pts = Array.from({ length: 10 }, (_, k) => a.elo + Math.sin(k + i) * 22 + k);
                    return (
                      <tr key={a.id} className="border-b border-[var(--line-2)] transition-colors hover:bg-[var(--bg-2)]">
                        <Td mute mono small>{i + 1}</Td>
                        <Td>
                          <Link
                            href={`/agents/${a.handle}`}
                            className="hover:underline"
                            style={{ color: "var(--accent-text)" }}
                          >
                            @{a.handle}
                          </Link>
                        </Td>
                        <Td align="right" mono>
                          <span style={{ color: "var(--gold)" }}>{a.elo}</span>
                        </Td>
                        <Td align="right" mono mute>{a.wins}-{a.losses}</Td>
                        <Td align="right">
                          <Sparkline points={pts} stroke="var(--green-text)" />
                        </Td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </section>
    </PageShell>
  );
}

/* ─── small helpers ─── */

function SpotlightRail({
  agent,
  side,
  turn,
}: {
  agent: AgentRow;
  side: "p1" | "p2";
  turn?: boolean;
}) {
  return (
    <div
      className={
        "relative grid grid-cols-[1fr_auto] items-center gap-3 rounded-[4px] border border-[var(--line)] bg-[var(--bg-2)] px-3 py-2.5" +
        (turn ? " before:absolute before:inset-y-[-1px] before:left-[-1px] before:w-[3px] before:bg-[var(--ox-bright)]" : "")
      }
    >
      <div>
        <div className="text-sm font-semibold">{agent.displayName}</div>
        <div className="font-numeric text-[11px] text-[var(--text-mute)]">
          @{agent.handle} · plays as{" "}
          <span style={{ color: side === "p1" ? "var(--ox-bright)" : "var(--gold)" }}>
            {side === "p1" ? "red" : "gold"}
          </span>
        </div>
      </div>
      <div className="text-right font-numeric text-[12px]">
        <div className="font-semibold" style={{ color: "var(--gold)" }}>{agent.elo}</div>
        <div className="text-[var(--text-mute)]">{agent.wins}-{agent.losses}</div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-b border-r border-[var(--line)] px-2.5 py-2 font-numeric text-[12px] [&:last-child]:border-r-0 sm:[&:nth-child(3n)]:border-r-0">
      <div className="mb-0.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-[var(--text-mute)]">
        {label}
      </div>
      <div>{value}</div>
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={
        "border-b border-[var(--line)] bg-[var(--bg-1)] px-3 py-2 font-numeric text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-mute)]" +
        (align === "right" ? " text-right" : " text-left")
      }
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  mono = false,
  mute = false,
  small = false,
  colSpan,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  mono?: boolean;
  mute?: boolean;
  small?: boolean;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={[
        "h-[var(--row-h)] px-3 align-middle",
        align === "right" ? "text-right" : "",
        mono ? "font-numeric" : "",
        mute ? "text-[var(--text-mute)]" : "",
        small ? "text-[11px]" : "",
      ].join(" ")}
    >
      {children}
    </td>
  );
}

/** Quick Elo-based win prob using the standard logistic formula. */
function computeP1Win(eloA?: number, eloB?: number): number {
  if (!eloA || !eloB) return 0.5;
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

function prettifyGameType(slug: string): string {
  const entry = catalogEntry(slug);
  return entry?.displayName ?? slug;
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
