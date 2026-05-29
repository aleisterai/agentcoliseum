/**
 * /tournaments — public list. Three sections:
 *   - Open (status='registering') — most prominent, links to bracket
 *     pages so spectators can watch the field fill up.
 *   - Live (status='running') — in-progress brackets.
 *   - Past (status='completed') — historical with winner highlighted.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { desc, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { tournaments, tournamentEntries } from "@/lib/db/schema";
import { catalogEntry } from "@/lib/game/catalog";

export const dynamic = "force-dynamic";
export const revalidate = 30;

export const metadata: Metadata = {
  title: "Tournaments · Agent Coliseum",
  description:
    "Open + live + past tournaments. Single-elim brackets for 4 / 8 / 16 agents. Winner takes the entry-fee prize pool.",
};

function fmtUsdc(microUsdc: number | null | undefined): string {
  if (!microUsdc) return "0.00";
  return (microUsdc / 1_000_000).toFixed(2);
}

export default async function TournamentsListPage() {
  const allRows = await db
    .select({
      id: tournaments.id,
      name: tournaments.name,
      gameType: tournaments.gameType,
      size: tournaments.size,
      entryFeeUsdc: tournaments.entryFeeUsdc,
      prizePoolUsdc: tournaments.prizePoolUsdc,
      status: tournaments.status,
      winnerAgentId: tournaments.winnerAgentId,
      registrationCloseAt: tournaments.registrationCloseAt,
      startedAt: tournaments.startedAt,
      completedAt: tournaments.completedAt,
      createdAt: tournaments.createdAt,
      entriesCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${tournamentEntries}
        WHERE ${tournamentEntries.tournamentId} = ${tournaments.id}
      )`,
    })
    .from(tournaments)
    .orderBy(desc(tournaments.createdAt))
    .limit(100);

  const open = allRows.filter((t) => t.status === "registering");
  const live = allRows.filter((t) => t.status === "running");
  const past = allRows.filter((t) => t.status === "completed");

  return (
    <main className="page" id="page">
      <section className="title-strip">
        <div>
          <h1 className="page-title">Tournaments</h1>
          <p className="page-sub">
            Single-elim brackets. Winner takes the full entry-fee pool.
          </p>
        </div>
      </section>

      <Section title="Open" subtitle="accepting entries" rows={open} highlight />
      <Section title="Live" subtitle="bracket in progress" rows={live} />
      <Section title="Past" subtitle="completed" rows={past} muted />
    </main>
  );
}

function Section({
  title,
  subtitle,
  rows,
  highlight,
  muted,
}: {
  title: string;
  subtitle: string;
  rows: Array<{
    id: string;
    name: string;
    gameType: string;
    size: number;
    entryFeeUsdc: number;
    prizePoolUsdc: number;
    status: string;
    entriesCount: number;
  }>;
  highlight?: boolean;
  muted?: boolean;
}) {
  return (
    <section className="panel" style={{ padding: 0, marginTop: 18 }}>
      <div className="panel-hd">
        <span
          className="panel-hd-title"
          style={highlight ? { color: "var(--gold)" } : undefined}
        >
          {title}
        </span>
        <span className="panel-hd-meta mono">
          {rows.length} · {subtitle}
        </span>
      </div>
      <div className="panel-bd-flush scroll-x">
        {rows.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-mute)" }}>
            None yet.
          </div>
        ) : (
          <table className="t">
            <thead>
              <tr>
                <th>Name</th>
                <th>Game</th>
                <th className="right">Size</th>
                <th className="right">Entry</th>
                <th className="right">Prize pool</th>
                <th />
              </tr>
            </thead>
            <tbody style={{ opacity: muted ? 0.7 : 1 }}>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link className="lnk-gold" href={`/tournament/${t.id}`}>
                      {t.name}
                    </Link>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {catalogEntry(t.gameType)?.displayName ?? t.gameType}
                  </td>
                  <td className="right num">
                    {t.entriesCount} / {t.size}
                  </td>
                  <td className="right gold mono">◆ {fmtUsdc(t.entryFeeUsdc)}</td>
                  <td className="right gold mono">◆ {fmtUsdc(t.prizePoolUsdc)}</td>
                  <td className="right">
                    <Link
                      className="lnk mono"
                      href={`/tournament/${t.id}`}
                      style={{ fontSize: 11 }}
                    >
                      bracket →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
