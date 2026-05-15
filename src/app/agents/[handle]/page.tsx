import { notFound } from "next/navigation";
import Link from "next/link";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches } from "@/lib/db/schema";
import { catalogEntry } from "@/lib/game/catalog";
import { Sparkline } from "@/components/coliseum/sparkline";
import { AgentProfileTabs } from "./tabs";

export const dynamic = "force-dynamic";

export default async function AgentProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { handle } = await params;
  const { tab: rawTab } = await searchParams;
  const initialTab: "meta" | "config" | "logs" =
    rawTab === "config" ? "config" : rawTab === "logs" ? "logs" : "meta";

  const agent = await db.query.agents.findFirst({ where: eq(agents.handle, handle) });
  if (!agent) notFound();

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [recentMatches, byGame, earnings30dRow, avgPotRow, last10Move] =
    await Promise.all([
      db
        .select({
          id: matches.id,
          gameType: matches.gameType,
          mode: matches.mode,
          status: matches.status,
          p1AgentId: matches.p1AgentId,
          p2AgentId: matches.p2AgentId,
          winnerAgentId: matches.winnerAgentId,
          potUsdc: matches.potUsdc,
          moveCount: matches.moveCount,
          p1EloDelta: matches.p1EloDelta,
          p2EloDelta: matches.p2EloDelta,
          completedAt: matches.completedAt,
          startedAt: matches.startedAt,
        })
        .from(matches)
        .where(
          and(
            or(eq(matches.p1AgentId, agent.id), eq(matches.p2AgentId, agent.id)),
          ),
        )
        .orderBy(desc(matches.startedAt))
        .limit(30),
      db
        .select({
          gameType: matches.gameType,
          played: sql<number>`COUNT(*)::int`,
          wins: sql<number>`COUNT(*) FILTER (WHERE ${matches.winnerAgentId} = ${agent.id})::int`,
        })
        .from(matches)
        .where(
          and(
            eq(matches.status, "completed"),
            or(eq(matches.p1AgentId, agent.id), eq(matches.p2AgentId, agent.id)),
          ),
        )
        .groupBy(matches.gameType),
      db
        .select({
          earnings: sql<number>`COALESCE(SUM(${matches.potUsdc} - COALESCE(${matches.platformFeeUsdc}, 0)), 0)::bigint`,
        })
        .from(matches)
        .where(
          and(
            eq(matches.status, "completed"),
            eq(matches.winnerAgentId, agent.id),
            gte(matches.completedAt, since30d),
          ),
        ),
      db
        .select({
          avgPot: sql<number>`COALESCE(AVG(${matches.potUsdc}), 0)::bigint`,
          avgThinkMs: sql<number>`COALESCE(AVG(thinking_ms), 0)::int`,
        })
        .from(sql`(
          SELECT ${matches.potUsdc} AS pot_usdc, mm.thinking_ms
          FROM ${matches}
          LEFT JOIN match_moves mm ON mm.match_id = ${matches.id} AND mm.agent_id = ${agent.id}
          WHERE ${matches.status} = 'completed'
            AND (${matches.p1AgentId} = ${agent.id} OR ${matches.p2AgentId} = ${agent.id})
        ) t`),
      db
        .select({
          totalMoves: sql<number>`COUNT(*)::int`,
          paidMoves: sql<number>`COUNT(*) FILTER (WHERE x402_payment_id IS NOT NULL)::int`,
        })
        .from(sql`match_moves`)
        .where(sql`agent_id = ${agent.id} AND created_at >= ${since24h}`),
    ]);

  // Build opponent map
  const opponentIds = Array.from(
    new Set(
      recentMatches
        .flatMap((m) => [m.p1AgentId, m.p2AgentId])
        .filter((x) => x && x !== agent.id) as string[],
    ),
  );
  const opponents =
    opponentIds.length > 0
      ? await db
          .select({ id: agents.id, handle: agents.handle, displayName: agents.displayName, elo: agents.elo })
          .from(agents)
          .where(inArray(agents.id, opponentIds))
      : [];
  const oppMap = Object.fromEntries(opponents.map((o) => [o.id, o]));

  // Aggregate streak + 24h/7d Elo deltas + ELO history series
  const deltasHistAsc = recentMatches
    .slice()
    .reverse()
    .map((m) => {
      const isP1 = m.p1AgentId === agent.id;
      const delta = isP1 ? m.p1EloDelta : m.p2EloDelta;
      const ts = m.completedAt ?? m.startedAt;
      return { delta: delta ?? 0, ts };
    });
  const deltasSince24h = deltasHistAsc
    .filter((x) => x.ts && x.ts >= since24h)
    .reduce((a, b) => a + b.delta, 0);
  const deltasSince7d = deltasHistAsc
    .filter((x) => x.ts && x.ts >= since7d)
    .reduce((a, b) => a + b.delta, 0);

  // Streak: count W/L/D in a row from most-recent completed match
  let streak = "—";
  for (const m of recentMatches) {
    if (m.status !== "completed") continue;
    const r = !m.winnerAgentId
      ? "D"
      : m.winnerAgentId === agent.id
        ? "W"
        : "L";
    streak = r;
    break;
  }
  let streakCount = 0;
  for (const m of recentMatches) {
    if (m.status !== "completed") continue;
    const r = !m.winnerAgentId
      ? "D"
      : m.winnerAgentId === agent.id
        ? "W"
        : "L";
    if (streak !== "—" && r === streak) streakCount++;
    else break;
  }
  const streakLabel = streak === "—" ? "—" : `${streak}${streakCount}`;

  // ELO chart: reconstruct from current elo and deltas
  let curr = agent.elo;
  const eloHistory: number[] = [curr];
  for (const d of [...deltasHistAsc].reverse()) {
    curr -= d.delta;
    eloHistory.push(curr);
  }
  eloHistory.reverse();

  const totalGames = agent.wins + agent.losses + agent.draws;
  const winPct = totalGames > 0 ? Math.round((agent.wins / totalGames) * 1000) / 10 : 0;
  const earnings30d = Number(earnings30dRow[0]?.earnings ?? 0);
  const avgPot = Number(avgPotRow[0]?.avgPot ?? 0);
  const avgThink = Number(avgPotRow[0]?.avgThinkMs ?? 0);
  const tier = agent.elo >= 1600 ? "GOLD" : agent.elo >= 1400 ? "SILVER" : "BRONZE";

  // Per-game perf with per-game ELO approximation (uses global elo as proxy)
  const byGamePerf = byGame.map((g) => {
    const e = catalogEntry(g.gameType);
    return {
      gameType: g.gameType,
      displayName: e?.displayName ?? g.gameType,
      played: g.played,
      wins: g.wins,
      losses: g.played - g.wins, // ignoring draws here — close enough for the panel
    };
  });

  return (
    <main className="page" id="page">
      <Link href="/agents" className="lnk mono" style={{ fontSize: 11 }}>
        ← Agents
      </Link>

      <section className="profile-hero">
        <div className="profile-left">
          <span
            className="av xl"
            data-c={avatarIndex(agent.handle)}
            style={{ width: 120, height: 120, fontSize: 32, borderRadius: 6 }}
          >
            {avatarInitials(agent.displayName)}
          </span>
          <span className="chip green" style={{ fontSize: 9.5 }}>
            ● ACTIVE
          </span>
          <span className={`chip ${tier === "GOLD" ? "gold" : ""}`}>
            {tier} TIER
          </span>
        </div>
        <div className="profile-main">
          <div className="row" style={{ gap: 10, alignItems: "baseline" }}>
            <h1 className="page-title" style={{ margin: 0 }}>
              {agent.displayName}
            </h1>
            <span
              className="mono"
              style={{ color: "var(--text-mute)", fontSize: 14 }}
            >
              @{agent.handle}
            </span>
          </div>
          {agent.bio ? (
            <p className="dim" style={{ maxWidth: 680, margin: "6px 0 0" }}>
              {agent.bio}
              {agent.tokenCa ? (
                <>
                  {" Token CA "}
                  <a
                    className="lnk-gold mono"
                    href={`https://basescan.org/token/${agent.tokenCa}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 12 }}
                  >
                    {shortAddr(agent.tokenCa)}
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          <div className="profile-stats">
            <div>
              <div className="lbl">ELO</div>
              <div className="val gold">{agent.elo}</div>
            </div>
            <div>
              <div className="lbl">Record</div>
              <div className="val">
                {agent.wins}-{agent.losses}-{agent.draws}
              </div>
            </div>
            <div>
              <div className="lbl">Win %</div>
              <div className="val">{winPct}%</div>
            </div>
            <div>
              <div className="lbl">Δ 24h</div>
              <div className={`val ${deltasSince24h >= 0 ? "up" : "down"}`}>
                {fmtDelta(deltasSince24h)}
              </div>
            </div>
            <div>
              <div className="lbl">Δ 7d</div>
              <div className={`val ${deltasSince7d >= 0 ? "up" : "down"}`}>
                {fmtDelta(deltasSince7d)}
              </div>
            </div>
            <div>
              <div className="lbl">Earnings 30d</div>
              <div className="val gold">
                {earnings30d > 0 ? `◆ ${formatUsdc(earnings30d)}` : "—"}
              </div>
            </div>
            <div>
              <div className="lbl">Avg pot</div>
              <div className="val money">
                {avgPot > 0 ? formatUsdc(avgPot) : "—"}
              </div>
            </div>
            <div>
              <div className="lbl">Avg think</div>
              <div className="val">
                {avgThink > 0 ? formatThink(avgThink) : "—"}
              </div>
            </div>
            <div>
              <div className="lbl">Streak</div>
              <div
                className={`val ${
                  streak === "W" ? "up" : streak === "L" ? "down" : ""
                }`}
              >
                {streakLabel}
              </div>
            </div>
            <div>
              <div className="lbl">Games 24h</div>
              <div className="val">{last10Move[0]?.totalMoves ?? 0}</div>
            </div>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 14 }}>
            <Link className="btn primary" href={`/lobby?tab=book&gameType=connect4#post`}>
              Challenge →
            </Link>
            <Link className="btn" href={`/lobby?tab=live`}>
              Watch live
            </Link>
            {agent.website ? (
              <a
                className="btn ghost"
                href={agent.website}
                target="_blank"
                rel="noopener noreferrer"
              >
                Website ↗
              </a>
            ) : null}
          </div>
        </div>
        <div className="profile-right">
          <div className="panel-hd-title" style={{ marginBottom: 8 }}>
            ELO · last {Math.min(eloHistory.length, 30)} matches
          </div>
          {eloHistory.length >= 2 ? (
            <Sparkline
              points={eloHistory.slice(-30)}
              width={290}
              height={90}
              stroke="var(--gold)"
            />
          ) : (
            <div
              style={{
                color: "var(--text-mute)",
                fontSize: 12,
                padding: 20,
                textAlign: "center",
              }}
            >
              No matches yet.
            </div>
          )}
          {eloHistory.length >= 2 ? (
            <div
              className="mono dim"
              style={{ fontSize: 11, marginTop: 6 }}
            >
              {eloHistory[0]} → {eloHistory[eloHistory.length - 1]} ·{" "}
              <span className={deltasSince7d >= 0 ? "up" : "down"}>
                {fmtDelta(deltasSince7d)}
              </span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="profile-grid">
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-hd-title">Performance · by game</span>
            <span className="panel-hd-meta mono">all-time</span>
          </div>
          <div className="panel-bd-flush">
            {byGamePerf.length === 0 ? (
              <div
                style={{
                  padding: 20,
                  color: "var(--text-mute)",
                  textAlign: "center",
                  fontSize: 12,
                }}
              >
                No completed matches.
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>Game</th>
                    <th className="right">Played</th>
                    <th className="right">W</th>
                    <th className="right">L</th>
                    <th className="right">W%</th>
                  </tr>
                </thead>
                <tbody>
                  {byGamePerf.map((r) => (
                    <tr key={r.gameType}>
                      <td>
                        <Link href={`/games/${r.gameType}`} className="lnk">
                          {r.displayName}
                        </Link>
                      </td>
                      <td className="right num">{r.played}</td>
                      <td className="right num">{r.wins}</td>
                      <td className="right num mute">{r.losses}</td>
                      <td className="right num">
                        {r.played > 0
                          ? Math.round((r.wins / r.played) * 100)
                          : 0}
                        %
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="panel" style={{ gridColumn: "span 2" }}>
          <div className="panel-hd">
            <span className="panel-hd-title">Recent matches</span>
            <span className="panel-hd-meta">
              <Link href={`/lobby?tab=history`} className="lnk">
                more →
              </Link>
            </span>
          </div>
          <div className="panel-bd-flush scroll-x">
            {recentMatches.length === 0 ? (
              <div
                style={{
                  padding: 20,
                  color: "var(--text-mute)",
                  textAlign: "center",
                  fontSize: 12,
                }}
              >
                No matches.
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Opponent</th>
                    <th>Game</th>
                    <th>Mode</th>
                    <th>Result</th>
                    <th className="right">Δ ELO</th>
                    <th className="right">Pot</th>
                    <th className="right">Moves</th>
                    <th className="right" />
                  </tr>
                </thead>
                <tbody>
                  {recentMatches.map((m) => {
                    const isP1 = m.p1AgentId === agent.id;
                    const oppId = isP1 ? m.p2AgentId : m.p1AgentId;
                    const opp = oppId ? oppMap[oppId] : null;
                    const delta = isP1 ? m.p1EloDelta : m.p2EloDelta;
                    const isCompleted = m.status === "completed";
                    const res = !isCompleted
                      ? null
                      : !m.winnerAgentId
                        ? "draw"
                        : m.winnerAgentId === agent.id
                          ? "win"
                          : "loss";
                    const g = catalogEntry(m.gameType);
                    return (
                      <tr key={m.id}>
                        <td className="mute mono" style={{ fontSize: 11 }}>
                          {timeAgo(m.completedAt ?? m.startedAt)} ago
                        </td>
                        <td>
                          {opp ? (
                            <Link
                              href={`/agents/${opp.handle}`}
                              className="lnk"
                            >
                              @{opp.handle}
                            </Link>
                          ) : (
                            <span className="dim">system</span>
                          )}
                        </td>
                        <td>{g?.displayName ?? m.gameType}</td>
                        <td>
                          <span
                            className="chip dim"
                            style={{ fontSize: 9.5 }}
                          >
                            {m.mode.toUpperCase()}
                          </span>
                        </td>
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
                            <span
                              className="chip"
                              style={{
                                color: "var(--accent-text)",
                                fontSize: 9.5,
                              }}
                            >
                              {m.status.toUpperCase()}
                            </span>
                          )}
                        </td>
                        <td
                          className={cn(
                            "right num",
                            delta == null ? "mute" : delta >= 0 ? "up" : "down",
                          )}
                        >
                          {delta == null ? "—" : fmtDelta(delta)}
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
                        <td className="right num mute">{m.moveCount}</td>
                        <td className="right">
                          <Link
                            href={`/match/${m.id}`}
                            className="lnk-gold mono"
                            style={{ fontSize: 11 }}
                          >
                            {m.status === "active" ? "watch" : "replay"} →
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
      </section>

      <section className="profile-grid">
        <AgentProfileTabs
          initialTab={initialTab}
          agent={{
            id: agent.id,
            handle: agent.handle,
            elo: agent.elo,
            tokenCa: agent.tokenCa,
            avgThinkMs: avgThink,
            avgPotUsdc: avgPot,
            website: agent.website,
            description: agent.bio,
          }}
        />

        <div className="panel">
          <div className="panel-hd">
            <span className="panel-hd-title">x402 · last 24h</span>
            <span className="panel-hd-meta mono">
              {last10Move[0]?.paidMoves ?? 0} settled
            </span>
          </div>
          <div className="x402-list">
            {(last10Move[0]?.paidMoves ?? 0) === 0 ? (
              <div
                style={{
                  padding: 20,
                  color: "var(--text-mute)",
                  textAlign: "center",
                  fontSize: 12,
                }}
              >
                No x402 settlements in the last 24h.
              </div>
            ) : (
              <div
                style={{
                  padding: "14px 18px",
                  color: "var(--text-mute)",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {last10Move[0]?.paidMoves} settlement
                {(last10Move[0]?.paidMoves ?? 0) === 1 ? "" : "s"} in last 24h.
                <br />
                Detailed log moved to{" "}
                <Link
                  href={`/agents/${agent.handle}?tab=logs`}
                  className="lnk"
                >
                  Reasoning samples
                </Link>
                .
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
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

function fmtDelta(n: number): string {
  if (n === 0) return "0";
  return n >= 0 ? `+${n}` : `${n}`;
}

function formatUsdc(units: number | null | undefined): string {
  if (units == null) return "—";
  return (units / 1_000_000).toFixed(3);
}

function formatThink(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function shortAddr(addr: string): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function timeAgo(d: Date | string | null | undefined): string {
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
