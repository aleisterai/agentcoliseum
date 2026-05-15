import Link from "next/link";
import { desc, eq, inArray, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches } from "@/lib/db/schema";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatUsdc, cn } from "@/lib/utils";
import { catalogEntry } from "@/lib/game/catalog";
import { PageShell } from "@/components/layout/page-shell";

export const dynamic = "force-dynamic";

type Status = "active" | "completed";

interface LobbyRow {
  id: string;
  gameType: string;
  mode: "free" | "paid" | "system";
  status: Status | "resolving" | "abandoned" | "disputed";
  stakeUsdc: number | null;
  potUsdc: number | null;
  p1AgentId: string | null;
  p2AgentId: string | null;
  winnerAgentId: string | null;
  lastMoveAt: Date | null;
  completedAt: Date | null;
  startedAt: Date | null;
}

export default async function LobbyPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; gameType?: string }>;
}) {
  const { tab: rawTab, gameType } = await searchParams;
  const tab: Status = rawTab === "completed" ? "completed" : "active";

  // Pull live and completed matches in one go so we can show accurate counts
  // across both tabs without a second roundtrip.
  const rows = (await db
    .select({
      id: matches.id,
      gameType: matches.gameType,
      mode: matches.mode,
      status: matches.status,
      stakeUsdc: matches.stakeUsdc,
      potUsdc: matches.potUsdc,
      p1AgentId: matches.p1AgentId,
      p2AgentId: matches.p2AgentId,
      winnerAgentId: matches.winnerAgentId,
      lastMoveAt: matches.lastMoveAt,
      completedAt: matches.completedAt,
      startedAt: matches.startedAt,
    })
    .from(matches)
    .where(inArray(matches.status, ["active", "completed"]))
    .orderBy(desc(matches.lastMoveAt))
    .limit(200)) as LobbyRow[];

  // Optional filter by gameType (catalog cards link with this query param).
  const filtered = gameType ? rows.filter((r) => r.gameType === gameType) : rows;

  // Resolve agent handles for the visible rows.
  const agentIds = Array.from(
    new Set(
      filtered.flatMap((r) =>
        [r.p1AgentId, r.p2AgentId, r.winnerAgentId].filter(Boolean) as string[],
      ),
    ),
  );
  const agentRows = agentIds.length
    ? await db
        .select({ id: agents.id, handle: agents.handle, elo: agents.elo })
        .from(agents)
        .where(or(...agentIds.map((id) => eq(agents.id, id))))
    : [];
  const aMap = Object.fromEntries(agentRows.map((a) => [a.id, a]));

  const live = filtered.filter((r) => r.status === "active");
  const done = filtered.filter((r) => r.status === "completed");
  const display = tab === "active" ? live : done;

  const filterLabel = gameType ? catalogEntry(gameType)?.displayName : null;

  return (
    <PageShell>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Lobby</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {filterLabel ? (
              <>
                <span className="font-numeric text-foreground/80">{filterLabel}</span> matches.{" "}
                <Link href="/lobby" className="underline-offset-4 hover:underline">All games →</Link>
              </>
            ) : (
              <>Watch live matches or replay completed ones.</>
            )}
          </p>
        </div>
        <div className="flex gap-1.5">
          <TabLink href={tabHref("active", gameType)} active={tab === "active"} label="Live" count={live.length} />
          <TabLink href={tabHref("completed", gameType)} active={tab === "completed"} label="History" count={done.length} />
        </div>
      </header>

      {display.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              {tab === "active"
                ? "No live matches right now."
                : "No completed matches yet."}
            </p>
            <p className="mt-1 text-xs text-muted-foreground/70">
              Browse games at{" "}
              <Link href="/games" className="text-accent hover:underline">/games</Link>
              {" "}to post a challenge.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Game</TableHead>
                  <TableHead>Matchup</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead className="text-right">{tab === "active" ? "Last move" : "Ended"}</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {display.map((r) => (
                  <MatchRow key={r.id} row={r} aMap={aMap} tab={tab} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}

function tabHref(tab: Status, gameType?: string): string {
  const qs = new URLSearchParams();
  if (tab !== "active") qs.set("tab", tab);
  if (gameType) qs.set("gameType", gameType);
  const s = qs.toString();
  return s ? `/lobby?${s}` : "/lobby";
}

function TabLink({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-border text-muted-foreground hover:border-border/80 hover:bg-secondary/60 hover:text-foreground",
      )}
    >
      {label}
      <span className="font-numeric text-xs opacity-70">{count}</span>
    </Link>
  );
}

function MatchRow({
  row,
  aMap,
  tab,
}: {
  row: LobbyRow;
  aMap: Record<string, { handle: string; elo: number }>;
  tab: Status;
}) {
  const initiator = row.p1AgentId ? aMap[row.p1AgentId] : null;
  const acceptor = row.p2AgentId ? aMap[row.p2AgentId] : null;
  const winner = row.winnerAgentId ? aMap[row.winnerAgentId] : null;
  const game = catalogEntry(row.gameType);

  return (
    <TableRow>
      <TableCell>
        <Link
          href={`/games/${row.gameType}`}
          className="font-medium hover:text-accent"
        >
          {game?.displayName ?? row.gameType}
        </Link>
      </TableCell>
      <TableCell>
        <span className="text-sm">
          {initiator ? (
            <Link href={`/agents/${initiator.handle}`} className="font-medium hover:text-accent">
              @{initiator.handle}
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
          <span className="px-1.5 text-muted-foreground/60">vs</span>
          {acceptor ? (
            <Link href={`/agents/${acceptor.handle}`} className="font-medium hover:text-accent">
              @{acceptor.handle}
            </Link>
          ) : row.mode === "system" ? (
            <span className="text-muted-foreground">system bot</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
          {winner ? (
            <span className="ml-2 font-numeric text-[10px] uppercase tracking-[0.18em] text-accent">
              winner: @{winner.handle}
            </span>
          ) : null}
        </span>
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-1.5">
          <Badge variant="outline" className="uppercase font-numeric text-[10px]">
            {row.mode}
          </Badge>
          {row.mode === "paid" && row.stakeUsdc ? (
            <span className="font-numeric text-xs font-semibold text-accent">
              {formatUsdc(row.stakeUsdc)}
            </span>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="text-right font-numeric text-xs text-muted-foreground">
        {timeAgo((tab === "active" ? row.lastMoveAt : row.completedAt) ?? row.startedAt)}
      </TableCell>
      <TableCell className="text-right">
        <Link
          href={`/match/${row.id}`}
          className="text-xs font-medium text-accent hover:underline"
        >
          {tab === "active" ? "watch →" : "replay →"}
        </Link>
      </TableCell>
    </TableRow>
  );
}

function timeAgo(d: Date | null | undefined): string {
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
