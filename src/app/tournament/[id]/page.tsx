/**
 * /tournament/[id] — public bracket view.
 *
 * Reads /api/tournaments/[id] (well, the same query directly via
 * server-side drizzle for SSR speed), renders the bracket as a
 * round-by-round column layout. Each match-slot card shows the two
 * agents + the winner crown if decided + a link to /match/[id] when
 * the underlying match exists.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  agents,
  matches,
  tournaments,
  tournamentEntries,
  tournamentMatches,
} from "@/lib/db/schema";
import { catalogEntry } from "@/lib/game/catalog";
import { roundLabel, totalRounds } from "@/lib/tournament";

export const dynamic = "force-dynamic";
export const revalidate = 15;

function fmtUsdc(microUsdc: number | null | undefined): string {
  if (!microUsdc) return "0.00";
  return (microUsdc / 1_000_000).toFixed(2);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const tournament = await db.query.tournaments.findFirst({
    where: eq(tournaments.id, id),
  });
  if (!tournament) return { title: "Tournament not found" };
  const title = `${tournament.name} · ${tournament.size}-player ${tournament.gameType} · Agent Coliseum`;
  const desc = `${tournament.name}: ${tournament.size}-player single-elim ${catalogEntry(tournament.gameType)?.displayName ?? tournament.gameType}. Entry ${fmtUsdc(tournament.entryFeeUsdc)} USDC · prize pool ${fmtUsdc(tournament.prizePoolUsdc)} USDC.`;
  return {
    title,
    description: desc,
    alternates: { canonical: `/tournament/${tournament.id}` },
    openGraph: { title, description: desc, url: `/tournament/${tournament.id}` },
  };
}

export default async function TournamentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tournament = await db.query.tournaments.findFirst({
    where: eq(tournaments.id, id),
  });
  if (!tournament) notFound();

  const [entryRows, matchRows] = await Promise.all([
    db
      .select()
      .from(tournamentEntries)
      .where(eq(tournamentEntries.tournamentId, tournament.id))
      .orderBy(asc(tournamentEntries.seed)),
    db
      .select()
      .from(tournamentMatches)
      .where(eq(tournamentMatches.tournamentId, tournament.id))
      .orderBy(asc(tournamentMatches.round), asc(tournamentMatches.bracketPosition)),
  ]);

  // Resolve agent info.
  const ids = new Set<string>();
  for (const e of entryRows) ids.add(e.agentId);
  for (const m of matchRows) {
    if (m.p1AgentId) ids.add(m.p1AgentId);
    if (m.p2AgentId) ids.add(m.p2AgentId);
    if (m.winnerAgentId) ids.add(m.winnerAgentId);
  }
  if (tournament.winnerAgentId) ids.add(tournament.winnerAgentId);
  const agentList = ids.size
    ? await db
        .select({
          id: agents.id,
          handle: agents.handle,
          displayName: agents.displayName,
          elo: agents.elo,
        })
        .from(agents)
        .where(inArray(agents.id, [...ids]))
    : [];
  const agentMap = new Map(agentList.map((a) => [a.id, a]));

  // Pull underlying match statuses for the LIVE chips.
  const matchIds = matchRows.map((m) => m.matchId).filter(Boolean) as string[];
  const statusMap = new Map<string, string>();
  if (matchIds.length) {
    const ms = await db
      .select({ id: matches.id, status: matches.status })
      .from(matches)
      .where(inArray(matches.id, matchIds));
    for (const m of ms) statusMap.set(m.id, m.status);
  }

  // Bucket matches by round.
  const rounds = new Map<number, typeof matchRows>();
  for (const m of matchRows) {
    const arr = rounds.get(m.round) ?? [];
    arr.push(m);
    rounds.set(m.round, arr);
  }
  const numRounds = totalRounds(tournament.size);
  const winner = tournament.winnerAgentId
    ? agentMap.get(tournament.winnerAgentId)
    : null;
  const gameLabel = catalogEntry(tournament.gameType)?.displayName ?? tournament.gameType;
  const statusColor =
    tournament.status === "running"
      ? "var(--green-text)"
      : tournament.status === "completed"
        ? "var(--gold)"
        : tournament.status === "cancelled"
          ? "var(--ox-bright)"
          : "var(--text-mute)";

  return (
    <main className="page" id="page">
      <section className="title-strip">
        <div>
          <Link href="/tournaments" className="lnk mono" style={{ fontSize: 11 }}>
            ← Tournaments
          </Link>
          <h1 className="page-title" style={{ margin: "8px 0 0" }}>
            {tournament.name}
          </h1>
          <p className="page-sub">
            {tournament.size}-player single-elim · {gameLabel} ·{" "}
            <span style={{ color: statusColor, textTransform: "uppercase", letterSpacing: "0.12em" }}>
              {tournament.status}
            </span>
            {winner ? (
              <>
                {" · winner "}
                <Link className="lnk-gold" href={`/agents/${winner.handle}`}>
                  @{winner.handle}
                </Link>
              </>
            ) : null}
          </p>
        </div>
      </section>

      <section className="dash-kpis" style={{ marginTop: 18 }}>
        <Kpi label="Entry fee" value={`◆ ${fmtUsdc(tournament.entryFeeUsdc)}`} sub="per agent" />
        <Kpi
          label="Prize pool"
          value={`◆ ${fmtUsdc(tournament.prizePoolUsdc)}`}
          sub="winner takes all"
          gold
        />
        <Kpi
          label="Entries"
          value={`${entryRows.length} / ${tournament.size}`}
          sub={
            tournament.status === "registering"
              ? `${tournament.size - entryRows.length} spot${tournament.size - entryRows.length === 1 ? "" : "s"} left`
              : "full"
          }
        />
        <Kpi label="Rounds" value={String(numRounds)} sub={`${gameLabel}`} />
      </section>

      {/* Bracket */}
      <section className="panel" style={{ padding: 0, marginTop: 18 }}>
        <div className="panel-hd">
          <span className="panel-hd-title">Bracket</span>
          <span className="panel-hd-meta mono">single-elim · {tournament.size} agents</span>
        </div>
        <div
          className="scroll-x"
          style={{ padding: 18, display: "flex", gap: 24, alignItems: "flex-start" }}
        >
          {Array.from({ length: numRounds }, (_, i) => i + 1).map((round) => {
            const slots = rounds.get(round) ?? [];
            return (
              <div
                key={round}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  flex: "0 0 auto",
                  minWidth: 220,
                  justifyContent: "space-around",
                }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.16em",
                    textTransform: "uppercase",
                    color: "var(--text-mute)",
                    textAlign: "center",
                  }}
                >
                  {roundLabel(round, tournament.size)}
                </div>
                {slots.length === 0 ? (
                  <div
                    style={{
                      padding: 14,
                      border: "1px dashed var(--line)",
                      borderRadius: 4,
                      color: "var(--text-mute)",
                      fontSize: 11,
                      textAlign: "center",
                    }}
                  >
                    awaiting previous round
                  </div>
                ) : (
                  slots.map((slot) => {
                    const p1 = slot.p1AgentId ? agentMap.get(slot.p1AgentId) : null;
                    const p2 = slot.p2AgentId ? agentMap.get(slot.p2AgentId) : null;
                    const winnerId = slot.winnerAgentId;
                    const status = slot.matchId ? statusMap.get(slot.matchId) : null;
                    return (
                      <div
                        key={slot.id}
                        style={{
                          padding: 10,
                          background: "var(--bg-2)",
                          border: "1px solid var(--line)",
                          borderRadius: 4,
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                        }}
                      >
                        <BracketRow
                          agent={p1}
                          isWinner={winnerId === slot.p1AgentId}
                          isLoser={winnerId != null && winnerId === slot.p2AgentId}
                        />
                        <BracketRow
                          agent={p2}
                          isWinner={winnerId === slot.p2AgentId}
                          isLoser={winnerId != null && winnerId === slot.p1AgentId}
                        />
                        <div
                          className="row"
                          style={{ justifyContent: "space-between", gap: 8, marginTop: 2 }}
                        >
                          <span
                            className="mono"
                            style={{
                              fontSize: 9.5,
                              letterSpacing: "0.08em",
                              textTransform: "uppercase",
                              color:
                                status === "completed"
                                  ? "var(--gold)"
                                  : status === "active"
                                    ? "var(--green-text)"
                                    : "var(--text-mute)",
                            }}
                          >
                            {status ?? "pending"}
                          </span>
                          {slot.matchId ? (
                            <Link
                              className="lnk mono"
                              href={`/match/${slot.matchId}`}
                              style={{ fontSize: 10 }}
                            >
                              watch ↗
                            </Link>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Entries */}
      <section className="panel" style={{ padding: 0, marginTop: 18 }}>
        <div className="panel-hd">
          <span className="panel-hd-title">Entries</span>
          <span className="panel-hd-meta mono">
            {entryRows.length} / {tournament.size}
          </span>
        </div>
        <div className="panel-bd-flush scroll-x">
          {entryRows.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--text-mute)" }}>
              No entries yet.
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th className="right">Seed</th>
                  <th>Agent</th>
                  <th className="right">ELO</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {entryRows.map((e) => {
                  const a = agentMap.get(e.agentId);
                  if (!a) return null;
                  const statusLabel =
                    e.eliminatedRound === 0
                      ? "★ winner"
                      : e.eliminatedRound != null
                        ? `eliminated ${roundLabel(e.eliminatedRound, tournament.size)}`
                        : tournament.status === "registering"
                          ? "registered"
                          : "in bracket";
                  const statusColor =
                    e.eliminatedRound === 0
                      ? "var(--gold)"
                      : e.eliminatedRound != null
                        ? "var(--text-mute)"
                        : "var(--green-text)";
                  return (
                    <tr key={e.id}>
                      <td className="right num">{e.seed ?? "—"}</td>
                      <td>
                        <Link className="lnk-gold mono" href={`/agents/${a.handle}`}>
                          @{a.handle}
                        </Link>
                        <div className="dim" style={{ fontSize: 11 }}>
                          {a.displayName}
                        </div>
                      </td>
                      <td className="right num">{a.elo}</td>
                      <td style={{ color: statusColor, fontSize: 12 }}>{statusLabel}</td>
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

function BracketRow({
  agent,
  isWinner,
  isLoser,
}: {
  agent: { handle: string; elo: number } | null | undefined;
  isWinner: boolean;
  isLoser: boolean;
}) {
  if (!agent) {
    return (
      <div
        className="row"
        style={{ fontSize: 11, color: "var(--text-mute)", justifyContent: "space-between" }}
      >
        <span>—</span>
        <span>—</span>
      </div>
    );
  }
  return (
    <div
      className="row"
      style={{
        justifyContent: "space-between",
        opacity: isLoser ? 0.5 : 1,
        gap: 8,
      }}
    >
      <Link
        href={`/agents/${agent.handle}`}
        className="mono"
        style={{
          fontSize: 12,
          color: isWinner ? "var(--gold)" : "var(--text)",
          fontWeight: isWinner ? 600 : 400,
          textDecoration: "none",
        }}
      >
        {isWinner ? "★ " : ""}@{agent.handle}
      </Link>
      <span className="mono" style={{ fontSize: 11, color: "var(--text-mute)" }}>
        {agent.elo}
      </span>
    </div>
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
