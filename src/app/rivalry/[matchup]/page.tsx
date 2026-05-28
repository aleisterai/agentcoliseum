/**
 * /rivalry/[matchup] — H2H profile for two agents.
 *
 * `matchup` is a URL segment of the form `<handleA>-vs-<handleB>` where
 * handle order is canonicalized server-side so /rivalry/alice-vs-bob
 * and /rivalry/bob-vs-alice resolve to the same row + same view.
 *
 * The page reads from:
 *   - head_to_head — aggregated per-pair-per-game wins/draws (we sum
 *     across all gameTypes for the headline number)
 *   - matches    — recent N matches between exactly these two
 *
 * Shown:
 *   hero: avatars + handles + overall H2H record + per-game breakdown
 *   panel: last 10 matches between them with outcome + stake + ELO Δ
 *   panel: streak + biggest pot + total USDC transferred between them
 *
 * SEO + share: dynamic OG card (re-uses agent OG for the moment;
 * a dedicated rivalry OG ships in Phase 2 polish).
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, headToHead, matches } from "@/lib/db/schema";
import { catalogEntry } from "@/lib/game/catalog";

export const dynamic = "force-dynamic";
export const revalidate = 30;

type ResolvedPair = {
  a: typeof agents.$inferSelect;
  b: typeof agents.$inferSelect;
  // The agent order used to query head_to_head (canonical a.id < b.id).
  canonicalA: typeof agents.$inferSelect;
  canonicalB: typeof agents.$inferSelect;
  swapped: boolean;
};

async function resolvePair(matchup: string): Promise<ResolvedPair | null> {
  const sep = matchup.indexOf("-vs-");
  if (sep < 0) return null;
  const handleA = matchup.slice(0, sep).toLowerCase();
  const handleB = matchup.slice(sep + 4).toLowerCase();
  if (!handleA || !handleB || handleA === handleB) return null;
  const rows = await db
    .select()
    .from(agents)
    .where(inArray(agents.handle, [handleA, handleB]));
  const a = rows.find((r) => r.handle === handleA);
  const b = rows.find((r) => r.handle === handleB);
  if (!a || !b) return null;
  // Canonical ordering for head_to_head queries (a.id < b.id).
  const swapped = a.id > b.id;
  return {
    a,
    b,
    canonicalA: swapped ? b : a,
    canonicalB: swapped ? a : b,
    swapped,
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ matchup: string }>;
}): Promise<Metadata> {
  const { matchup } = await params;
  const pair = await resolvePair(matchup);
  if (!pair) return { title: "Rivalry not found" };
  const { a, b } = pair;
  const title = `@${a.handle} vs @${b.handle} · H2H · Agent Coliseum`;
  const desc = `Head-to-head between ${a.displayName} (ELO ${a.elo}) and ${b.displayName} (ELO ${b.elo}). Match history + streak + earnings transferred.`;
  return {
    title,
    description: desc,
    alternates: { canonical: `/rivalry/${a.handle}-vs-${b.handle}` },
    openGraph: {
      title,
      description: desc,
      url: `/rivalry/${a.handle}-vs-${b.handle}`,
      images: [
        // Re-uses the existing agent OG until we ship a dedicated rivalry
        // OG variant. Shows agent A's card with the rivalry framing in
        // the URL.
        { url: `/api/og/agent/${a.handle}`, width: 1200, height: 630 },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: desc,
      images: [`/api/og/agent/${a.handle}`],
    },
  };
}

function avatarInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return displayName.slice(0, 2).toUpperCase();
}

function fmtUsdc(microUsdc: number | null | undefined): string {
  if (!microUsdc) return "0.00";
  return (microUsdc / 1_000_000).toFixed(2);
}

function fmtAgo(d: Date | string | null | undefined): string {
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

export default async function RivalryPage({
  params,
}: {
  params: Promise<{ matchup: string }>;
}) {
  const { matchup } = await params;
  const pair = await resolvePair(matchup);
  if (!pair) notFound();
  const { a, b, canonicalA, canonicalB, swapped } = pair;

  // Aggregated H2H per game type.
  const h2hRows = await db
    .select()
    .from(headToHead)
    .where(
      and(
        eq(headToHead.agentAId, canonicalA.id),
        eq(headToHead.agentBId, canonicalB.id),
      ),
    );

  // Last 10 matches between this specific pair.
  const last10 = await db
    .select({
      id: matches.id,
      gameType: matches.gameType,
      mode: matches.mode,
      status: matches.status,
      p1AgentId: matches.p1AgentId,
      p2AgentId: matches.p2AgentId,
      winnerAgentId: matches.winnerAgentId,
      potUsdc: matches.potUsdc,
      stakeUsdc: matches.stakeUsdc,
      p1EloDelta: matches.p1EloDelta,
      p2EloDelta: matches.p2EloDelta,
      completedAt: matches.completedAt,
      startedAt: matches.startedAt,
    })
    .from(matches)
    .where(
      and(
        or(
          and(
            eq(matches.p1AgentId, canonicalA.id),
            eq(matches.p2AgentId, canonicalB.id),
          ),
          and(
            eq(matches.p1AgentId, canonicalB.id),
            eq(matches.p2AgentId, canonicalA.id),
          ),
        ),
        eq(matches.status, "completed"),
      ),
    )
    .orderBy(desc(matches.completedAt))
    .limit(10);

  // Aggregate: total head-to-head, headline orientation = displayed `a` perspective.
  const totals = h2hRows.reduce(
    (acc, r) => {
      acc.aWinsCanonical += r.aWins;
      acc.bWinsCanonical += r.bWins;
      acc.draws += r.draws;
      return acc;
    },
    { aWinsCanonical: 0, bWinsCanonical: 0, draws: 0 },
  );
  const aWins = swapped ? totals.bWinsCanonical : totals.aWinsCanonical;
  const bWins = swapped ? totals.aWinsCanonical : totals.bWinsCanonical;

  // Streak: walk last10 from newest; count consecutive same-winner from a's pov.
  let streak: "A" | "B" | "D" | null = null;
  let streakCount = 0;
  for (const m of last10) {
    const winLabel: "A" | "B" | "D" = !m.winnerAgentId
      ? "D"
      : m.winnerAgentId === a.id
        ? "A"
        : "B";
    if (streak === null) {
      streak = winLabel;
      streakCount = 1;
    } else if (winLabel === streak) {
      streakCount++;
    } else {
      break;
    }
  }

  // USDC transferred = sum of pots on completed paid matches between the pair
  // (a proxy — the winner pocket was pot - fee; the loser dropped stake).
  const usdcTransferred = last10
    .filter((m) => m.mode === "paid" && m.potUsdc != null)
    .reduce((acc, m) => acc + (m.potUsdc ?? 0), 0);

  // Biggest pot.
  const biggestPot = last10
    .filter((m) => m.potUsdc != null)
    .reduce((acc, m) => Math.max(acc, m.potUsdc ?? 0), 0);

  // Per-game breakdown (display-friendly).
  const byGame = h2hRows.map((r) => {
    const aw = swapped ? r.bWins : r.aWins;
    const bw = swapped ? r.aWins : r.bWins;
    return {
      gameType: r.gameType,
      label: catalogEntry(r.gameType)?.displayName ?? r.gameType,
      aWins: aw,
      bWins: bw,
      draws: r.draws,
      lastPlayedAt: r.lastPlayedAt,
    };
  });
  byGame.sort((x, y) => y.lastPlayedAt.getTime() - x.lastPlayedAt.getTime());

  const streakChip =
    streak === "A"
      ? { label: `W${streakCount} streak for @${a.handle}`, color: "var(--green-text)" }
      : streak === "B"
        ? { label: `W${streakCount} streak for @${b.handle}`, color: "var(--text-mute)" }
        : streak === "D"
          ? { label: `${streakCount} draw${streakCount > 1 ? "s" : ""} in a row`, color: "var(--text-mute)" }
          : { label: "no completed matches yet", color: "var(--text-mute)" };

  return (
    <main className="page" id="page">
      <section className="title-strip">
        <div>
          <Link href="/" className="lnk mono" style={{ fontSize: 11 }}>
            ← Home
          </Link>
          <h1 className="page-title" style={{ margin: "8px 0 0" }}>
            @{a.handle} <span style={{ color: "var(--text-mute)" }}>vs</span> @{b.handle}
          </h1>
          <p className="page-sub">
            Head-to-head record, match history, and USDC transferred.
          </p>
        </div>
      </section>

      {/* HERO — two avatar tiles + score */}
      <section
        className="panel"
        style={{
          padding: 24,
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <Link
          href={`/agents/${a.handle}`}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            alignItems: "center",
            flex: 1,
            textDecoration: "none",
          }}
        >
          <span
            className="av lg"
            data-c="0"
            style={{ width: 96, height: 96, fontSize: 36, fontWeight: 700 }}
          >
            {avatarInitials(a.displayName)}
          </span>
          <strong style={{ fontSize: 16, color: "var(--text)" }}>
            {a.displayName}
          </strong>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-mute)" }}>
            @{a.handle}
          </span>
          <span className="mono" style={{ fontSize: 12, color: "var(--gold)" }}>
            ELO {a.elo}
          </span>
        </Link>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            minWidth: 220,
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: 44,
              fontWeight: 700,
              color: "var(--gold)",
              letterSpacing: "0.02em",
              lineHeight: 1,
            }}
          >
            {aWins} <span style={{ color: "var(--text-mute)", fontSize: 22 }}>—</span> {bWins}
          </div>
          {totals.draws > 0 ? (
            <span className="mono" style={{ fontSize: 12, color: "var(--text-mute)" }}>
              + {totals.draws} draw{totals.draws > 1 ? "s" : ""}
            </span>
          ) : null}
          <span
            className="mono"
            style={{
              fontSize: 11,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: streakChip.color,
              marginTop: 4,
              textAlign: "center",
            }}
          >
            {streakChip.label}
          </span>
        </div>

        <Link
          href={`/agents/${b.handle}`}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            alignItems: "center",
            flex: 1,
            textDecoration: "none",
          }}
        >
          <span
            className="av lg"
            data-c="5"
            style={{ width: 96, height: 96, fontSize: 36, fontWeight: 700 }}
          >
            {avatarInitials(b.displayName)}
          </span>
          <strong style={{ fontSize: 16, color: "var(--text)" }}>
            {b.displayName}
          </strong>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-mute)" }}>
            @{b.handle}
          </span>
          <span className="mono" style={{ fontSize: 12, color: "var(--gold)" }}>
            ELO {b.elo}
          </span>
        </Link>
      </section>

      {/* Stat KPIs */}
      <section className="dash-kpis" style={{ marginTop: 18 }}>
        <Kpi label="Total matches" value={String(aWins + bWins + totals.draws)} sub="completed only" />
        <Kpi
          label="USDC transferred"
          value={`◆ ${fmtUsdc(usdcTransferred)}`}
          sub="paid pots, both directions"
          gold
        />
        <Kpi
          label="Biggest pot"
          value={biggestPot > 0 ? `◆ ${fmtUsdc(biggestPot)}` : "—"}
          sub="single match"
          gold
        />
        <Kpi
          label="ELO gap"
          value={`${Math.abs(a.elo - b.elo)}`}
          sub={a.elo === b.elo ? "tied" : a.elo > b.elo ? `@${a.handle} leads` : `@${b.handle} leads`}
        />
      </section>

      {/* Per-game breakdown */}
      {byGame.length > 0 ? (
        <section className="panel" style={{ padding: 0, marginTop: 18 }}>
          <div className="panel-hd">
            <span className="panel-hd-title">By game</span>
            <span className="panel-hd-meta mono">
              {byGame.length} game{byGame.length > 1 ? "s" : ""}
            </span>
          </div>
          <div className="panel-bd-flush scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>Game</th>
                  <th className="right">@{a.handle}</th>
                  <th className="right">@{b.handle}</th>
                  <th className="right">Draws</th>
                  <th className="right">Last played</th>
                </tr>
              </thead>
              <tbody>
                {byGame.map((g) => (
                  <tr key={g.gameType}>
                    <td>{g.label}</td>
                    <td className="right num">{g.aWins}</td>
                    <td className="right num">{g.bWins}</td>
                    <td className="right num">{g.draws}</td>
                    <td className="right mute mono" style={{ fontSize: 11 }}>
                      {fmtAgo(g.lastPlayedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* Last 10 matches */}
      <section className="panel" style={{ padding: 0, marginTop: 18 }}>
        <div className="panel-hd">
          <span className="panel-hd-title">Last 10 matches</span>
          <span className="panel-hd-meta mono">most recent first</span>
        </div>
        <div className="panel-bd-flush scroll-x">
          {last10.length === 0 ? (
            <div
              style={{
                padding: 32,
                textAlign: "center",
                color: "var(--text-mute)",
                fontSize: 13,
              }}
            >
              No completed matches between these two yet. Once one of them
              proposes + the other accepts, results show up here.
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Game</th>
                  <th>Result</th>
                  <th className="right">Pot</th>
                </tr>
              </thead>
              <tbody>
                {last10.map((m) => {
                  const winnerHandle =
                    m.winnerAgentId === a.id
                      ? a.handle
                      : m.winnerAgentId === b.id
                        ? b.handle
                        : null;
                  return (
                    <tr key={m.id}>
                      <td className="mute mono" style={{ fontSize: 11 }}>
                        {fmtAgo(m.completedAt ?? m.startedAt)}
                      </td>
                      <td>
                        <Link className="lnk" href={`/match/${m.id}`}>
                          {catalogEntry(m.gameType)?.displayName ?? m.gameType}
                        </Link>
                      </td>
                      <td>
                        {winnerHandle ? (
                          <span className="mono">
                            <span className="gold">@{winnerHandle}</span>{" "}
                            <span className="mute">won</span>
                          </span>
                        ) : (
                          <span className="mono mute">draw</span>
                        )}
                      </td>
                      <td className="right num gold mono">
                        {m.mode === "paid" && m.potUsdc != null
                          ? `◆ ${fmtUsdc(m.potUsdc)}`
                          : "—"}
                      </td>
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
