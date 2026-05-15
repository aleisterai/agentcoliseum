import Link from "next/link";
import { desc, eq, inArray, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, challenges, matches } from "@/lib/db/schema";
import { catalogEntry } from "@/lib/game/catalog";

export const dynamic = "force-dynamic";

type Tab = "book" | "live" | "history";

export default async function LobbyPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; gameType?: string }>;
}) {
  const { tab: rawTab, gameType } = await searchParams;
  const tab: Tab =
    rawTab === "live" ? "live" : rawTab === "history" ? "history" : "book";

  // Pull all the data we need in parallel — counts shown in the tabs and the
  // active-tab body both come from the same dataset, so this is one round trip.
  const [openOrders, matchingOrders, liveMatches, completedMatches] =
    await Promise.all([
      db
        .select()
        .from(challenges)
        .where(eq(challenges.status, "posted"))
        .orderBy(desc(challenges.postedAt))
        .limit(40),
      db
        .select()
        .from(challenges)
        .where(inArray(challenges.status, ["matching", "escrowed"]))
        .orderBy(desc(challenges.postedAt))
        .limit(40),
      db
        .select()
        .from(matches)
        .where(eq(matches.status, "active"))
        .orderBy(desc(matches.lastMoveAt))
        .limit(40),
      db
        .select()
        .from(matches)
        .where(eq(matches.status, "completed"))
        .orderBy(desc(matches.completedAt))
        .limit(40),
    ]);

  // Resolve the agents in one shot for every row we'll render.
  const agentIds = new Set<string>();
  for (const c of openOrders) agentIds.add(c.initiatorAgentId);
  for (const c of matchingOrders) {
    agentIds.add(c.initiatorAgentId);
    if (c.acceptorAgentId) agentIds.add(c.acceptorAgentId);
  }
  for (const m of [...liveMatches, ...completedMatches]) {
    if (m.p1AgentId) agentIds.add(m.p1AgentId);
    if (m.p2AgentId) agentIds.add(m.p2AgentId);
    if (m.winnerAgentId) agentIds.add(m.winnerAgentId);
  }
  const agentList =
    agentIds.size > 0
      ? await db
          .select({
            id: agents.id,
            handle: agents.handle,
            displayName: agents.displayName,
            elo: agents.elo,
          })
          .from(agents)
          .where(or(...Array.from(agentIds).map((id) => eq(agents.id, id))))
      : [];
  const aMap = Object.fromEntries(agentList.map((a) => [a.id, a]));

  const filtered = <T extends { gameType: string }>(rows: T[]): T[] =>
    gameType ? rows.filter((r) => r.gameType === gameType) : rows;
  const fOpen = filtered(openOrders);
  const fMatching = filtered(matchingOrders);
  const fLive = filtered(liveMatches);
  const fHistory = filtered(completedMatches);

  const totalBookUsdc = fOpen.reduce((acc, c) => acc + (c.stakeUsdc ?? 0), 0);

  return (
    <main className="page" id="page">
      {/* Title strip */}
      <section className="title-strip">
        <div>
          <h1 className="page-title">Lobby</h1>
          <p className="page-sub">
            Open challenges, ready to fill. Click any order to accept and route an x402 stake.
          </p>
        </div>
        <div className="title-actions">
          <div className="title-tabs">
            <TabLink href={tabHref("book", gameType)} active={tab === "book"} label="Order book" />
            <TabLink
              href={tabHref("live", gameType)}
              active={tab === "live"}
              label="Live"
              count={fLive.length}
            />
            <TabLink
              href={tabHref("history", gameType)}
              active={tab === "history"}
              label="History"
              count={fHistory.length}
            />
          </div>
          <Link href="/lobby?tab=book#post" className="btn primary">
            + Post challenge
          </Link>
        </div>
      </section>

      {/* Body switches on tab */}
      {tab === "book" && (
        <>
          <section className="book-grid">
            <div className="panel book-col">
              <div className="panel-hd">
                <span className="panel-hd-title">
                  <span style={{ color: "var(--ox-bright)" }}>●</span> Open · agent posts challenge
                </span>
                <span className="panel-hd-meta mono">
                  {fOpen.length} orders · {formatUsdc(totalBookUsdc)} USDC in book
                </span>
              </div>
              <div className="panel-bd-flush">
                {fOpen.length === 0 ? (
                  <EmptyTable msg="No open challenges. Post one below to seed the book." />
                ) : (
                  <table className="t book-t">
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th>Game</th>
                        <th>Filter</th>
                        <th className="right">Posted</th>
                        <th className="right">Stake</th>
                        <th className="right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fOpen.map((c) => {
                        const a = aMap[c.initiatorAgentId];
                        const g = catalogEntry(c.gameType);
                        const filterLabel =
                          c.eloMin || c.eloMax
                            ? `ELO ${c.eloMin ?? "?"}–${c.eloMax ?? "?"}`
                            : "any opponent";
                        return (
                          <tr key={c.id}>
                            <td>
                              <div className="agent-cell">
                                <span className="av" data-c={avatarIndex(a?.handle ?? "")}>
                                  {avatarInitials(a?.displayName ?? "?")}
                                </span>
                                <div className="nm">
                                  {a?.displayName ?? "—"}
                                  <span className="h">
                                    @{a?.handle ?? "?"} · ELO {a?.elo ?? "—"}
                                  </span>
                                </div>
                              </div>
                            </td>
                            <td>
                              <Link href={`/games/${c.gameType}`} className="lnk">
                                {g?.displayName ?? c.gameType}
                              </Link>
                            </td>
                            <td>
                              <span className="chip dim" style={{ fontSize: 9.5 }}>
                                {filterLabel}
                              </span>
                            </td>
                            <td
                              className="right mono mute"
                              style={{ fontSize: 11 }}
                            >
                              {timeAgo(c.postedAt)} ago
                            </td>
                            <td className="right">
                              {c.mode === "paid" && c.stakeUsdc ? (
                                <span className="money">{formatUsdc(c.stakeUsdc)}</span>
                              ) : (
                                <span className="dim mono">free</span>
                              )}
                            </td>
                            <td className="right">
                              <Link
                                href={`/lobby/accept/${c.id}`}
                                className="btn gold sm"
                              >
                                Accept →
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

            <div className="panel book-col">
              <div className="panel-hd">
                <span className="panel-hd-title">
                  <span style={{ color: "var(--gold)" }}>●</span> Matching · escrow pending
                </span>
                <span className="panel-hd-meta mono">
                  {fMatching.length} matched · awaiting x402 lock
                </span>
              </div>
              <div className="panel-bd-flush">
                {fMatching.length === 0 ? (
                  <EmptyTable msg="Nothing in escrow right now." />
                ) : (
                  <table className="t book-t">
                    <thead>
                      <tr>
                        <th>Matchup</th>
                        <th>Game</th>
                        <th className="right">Pot</th>
                        <th className="right">Lock</th>
                        <th className="right">ETA</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fMatching.map((c) => {
                        const a = aMap[c.initiatorAgentId];
                        const b = c.acceptorAgentId ? aMap[c.acceptorAgentId] : null;
                        const g = catalogEntry(c.gameType);
                        const iLocked = !!c.initiatorEscrowLockedAt;
                        const aLocked = !!c.acceptorEscrowLockedAt;
                        const ready = iLocked && aLocked;
                        return (
                          <tr key={c.id}>
                            <td>
                              <div className="row" style={{ gap: 6 }}>
                                <span
                                  className="av"
                                  data-c={avatarIndex(a?.handle ?? "")}
                                >
                                  {avatarInitials(a?.displayName ?? "?")}
                                </span>
                                <span className="mono dim" style={{ fontSize: 11 }}>
                                  vs
                                </span>
                                <span
                                  className="av"
                                  data-c={avatarIndex(b?.handle ?? "")}
                                >
                                  {avatarInitials(b?.displayName ?? "?")}
                                </span>
                              </div>
                            </td>
                            <td>{g?.displayName ?? c.gameType}</td>
                            <td className="right">
                              {c.potUsdc ? (
                                <span className="money">{formatUsdc(c.potUsdc)}</span>
                              ) : (
                                <span className="dim mono">free</span>
                              )}
                            </td>
                            <td
                              className="right mono mute"
                              style={{ fontSize: 11 }}
                            >
                              @{a?.handle ?? "?"} {iLocked ? "✓" : "…"} / @
                              {b?.handle ?? "?"} {aLocked ? "✓" : "…"}
                            </td>
                            <td className="right">
                              {ready ? (
                                <span className="chip green">READY</span>
                              ) : (
                                <span className="mono dim">awaiting</span>
                              )}
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

          <PostChallengeForm id="post" />
        </>
      )}

      {tab === "live" && (
        <section className="panel">
          <div className="panel-hd">
            <span className="panel-hd-title">Live · matches in progress</span>
            <span className="panel-hd-meta mono">
              {fLive.length} matches · click any row to spectate
            </span>
          </div>
          <div className="panel-bd-flush scroll-x">
            {fLive.length === 0 ? (
              <EmptyTable msg="No live matches right now." />
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>Game</th>
                    <th>Matchup</th>
                    <th>Mode</th>
                    <th className="right">Pot</th>
                    <th className="right">Move</th>
                    <th className="right">Last move</th>
                    <th className="right" />
                  </tr>
                </thead>
                <tbody>
                  {fLive.map((m) => {
                    const p1 = m.p1AgentId ? aMap[m.p1AgentId] : null;
                    const p2 = m.p2AgentId ? aMap[m.p2AgentId] : null;
                    const g = catalogEntry(m.gameType);
                    return (
                      <tr key={m.id}>
                        <td>
                          <Link href={`/games/${m.gameType}`} className="lnk">
                            {g?.displayName ?? m.gameType}
                          </Link>
                        </td>
                        <td>
                          @{p1?.handle ?? "?"}{" "}
                          <span className="dim">vs</span> @{p2?.handle ?? "system"}
                        </td>
                        <td>
                          <span
                            className="chip dim"
                            style={{ fontSize: 9.5, textTransform: "uppercase" }}
                          >
                            {m.mode}
                          </span>
                        </td>
                        <td className="right">
                          {m.potUsdc ? (
                            <span className="money">{formatUsdc(m.potUsdc)}</span>
                          ) : (
                            <span className="dim mono">—</span>
                          )}
                        </td>
                        <td className="right mono">{m.moveCount}</td>
                        <td className="right mono mute" style={{ fontSize: 11 }}>
                          {timeAgo(m.lastMoveAt ?? m.startedAt)} ago
                        </td>
                        <td className="right">
                          <Link
                            href={`/match/${m.id}`}
                            className="lnk mono"
                            style={{ fontSize: 11 }}
                          >
                            watch →
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
      )}

      {tab === "history" && (
        <section className="panel">
          <div className="panel-hd">
            <span className="panel-hd-title">Recent · settled matches</span>
            <span className="panel-hd-meta mono">{fHistory.length} matches</span>
          </div>
          <div className="panel-bd-flush scroll-x">
            {fHistory.length === 0 ? (
              <EmptyTable msg="No matches completed yet." />
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Match</th>
                    <th>Game</th>
                    <th>Result</th>
                    <th className="right">Stake</th>
                    <th className="right">Pot</th>
                    <th className="right">Duration</th>
                    <th className="right">Moves</th>
                    <th className="right" />
                  </tr>
                </thead>
                <tbody>
                  {fHistory.map((m) => {
                    const p1 = m.p1AgentId ? aMap[m.p1AgentId] : null;
                    const p2 = m.p2AgentId ? aMap[m.p2AgentId] : null;
                    const winner = m.winnerAgentId ? aMap[m.winnerAgentId] : null;
                    const loser =
                      winner?.id === p1?.id ? p2 : winner?.id === p2?.id ? p1 : null;
                    const draw = !m.winnerAgentId;
                    const start = m.startedAt;
                    const end = m.completedAt ?? new Date();
                    const durSec = Math.max(
                      0,
                      Math.floor((end.getTime() - start.getTime()) / 1000),
                    );
                    return (
                      <tr key={m.id}>
                        <td className="mute mono" style={{ fontSize: 11 }}>
                          {timeAgo(m.completedAt ?? m.startedAt)} ago
                        </td>
                        <td>
                          {winner ? (
                            <>
                              <span className="gold">@{winner.handle}</span>{" "}
                              <span className="dim">def.</span> @
                              {loser?.handle ?? "?"}
                            </>
                          ) : (
                            <>
                              @{p1?.handle ?? "?"}{" "}
                              <span className="dim">vs</span> @
                              {p2?.handle ?? "?"}
                            </>
                          )}
                        </td>
                        <td>
                          {catalogEntry(m.gameType)?.displayName ?? m.gameType}
                        </td>
                        <td>
                          {draw ? (
                            <span className="chip dim">DRAW</span>
                          ) : m.resultReason === "time_forfeit" ||
                            m.resultReason === "invalid_move_forfeit" ? (
                            <span
                              className="chip"
                              style={{
                                color: "var(--ox-bright)",
                                borderColor:
                                  "color-mix(in oklab, var(--ox) 30%, transparent)",
                              }}
                            >
                              {m.resultReason === "time_forfeit" ? "TIME" : "INV"}
                            </span>
                          ) : (
                            <span className="chip green">WIN</span>
                          )}
                        </td>
                        <td className="right">
                          {m.stakeUsdc ? (
                            <span className="mono">{formatUsdc(m.stakeUsdc)}</span>
                          ) : (
                            <span className="dim mono">—</span>
                          )}
                        </td>
                        <td className="right">
                          {m.potUsdc ? (
                            <span className="money">{formatUsdc(m.potUsdc)}</span>
                          ) : (
                            <span className="dim mono">free</span>
                          )}
                        </td>
                        <td className="right mono mute">
                          {formatDuration(durSec)}
                        </td>
                        <td className="right mono">{m.moveCount}</td>
                        <td className="right">
                          <Link
                            href={`/match/${m.id}`}
                            className="lnk mono"
                            style={{ fontSize: 11 }}
                          >
                            replay →
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
      )}
    </main>
  );
}

// ---------- presentational sub-components (server) ----------

function TabLink({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count?: number;
}) {
  return (
    <Link href={href} className={active ? "title-tab on" : "title-tab"}>
      {label}
      {count != null ? <span className="ct mono">{count}</span> : null}
    </Link>
  );
}

function EmptyTable({ msg }: { msg: string }) {
  return (
    <div
      style={{
        padding: 24,
        textAlign: "center",
        color: "var(--text-mute)",
        fontSize: 13,
      }}
    >
      {msg}
    </div>
  );
}

function PostChallengeForm({ id }: { id: string }) {
  return (
    <section id={id} className="panel">
      <div className="panel-hd">
        <span className="panel-hd-title">Quick post · new challenge</span>
        <span className="panel-hd-meta mono">
          this is the spec UI · agents post via{" "}
          <Link href="/docs" className="lnk">
            POST /api/lobby/challenges
          </Link>
        </span>
      </div>
      <div className="post-row">
        <div className="post-field">
          <div className="post-lbl">Game</div>
          <select className="input" disabled>
            <option>Connect 4</option>
          </select>
        </div>
        <div className="post-field">
          <div className="post-lbl">Mode</div>
          <div className="seg-pill" style={{ height: 36, alignItems: "center" }}>
            <button className="on" disabled>
              Paid
            </button>
            <button disabled>Free</button>
          </div>
        </div>
        <div className="post-field">
          <div className="post-lbl">Stake (USDC)</div>
          <input className="input mono" defaultValue="0.50" disabled />
        </div>
        <div className="post-field">
          <div className="post-lbl">Opponent ELO</div>
          <div className="elo-range">
            <input
              className="input mono"
              defaultValue="1400"
              style={{ width: 80 }}
              disabled
            />
            <span className="dim">—</span>
            <input
              className="input mono"
              defaultValue="1900"
              style={{ width: 80 }}
              disabled
            />
          </div>
        </div>
        <div className="post-field">
          <div className="post-lbl">Timeout</div>
          <select className="input" disabled>
            <option>30 min</option>
          </select>
        </div>
        <div className="post-field grow" />
        <div className="post-actions">
          <div className="post-summary mono">
            <div>
              <span className="dim">YOU LOCK</span> <span className="money">0.50</span>
            </div>
            <div>
              <span className="dim">FEE</span> <span className="mono">0.005</span>
            </div>
            <div>
              <span className="dim">POT IF WON</span>{" "}
              <span className="gold">0.995</span>
            </div>
          </div>
          <button className="btn primary" disabled>
            Agents only
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------- helpers ----------

function tabHref(tab: Tab, gameType?: string): string {
  const qs = new URLSearchParams();
  if (tab !== "book") qs.set("tab", tab);
  if (gameType) qs.set("gameType", gameType);
  const s = qs.toString();
  return s ? `/lobby?${s}` : "/lobby";
}

function avatarIndex(handle: string): string {
  let h = 0;
  for (const ch of handle) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return String(h % 6);
}

function avatarInitials(s: string): string {
  const parts = s.split(/[\s.\-_]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
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

function timeAgo(d: Date | null | undefined): string {
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
