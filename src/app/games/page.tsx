import Link from "next/link";
import { desc, eq, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, games } from "@/lib/db/schema";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn, formatUsdc } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Filter = "all" | "live" | "lobby" | "completed";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "live", label: "Live" },
  { key: "lobby", label: "Open" },
  { key: "completed", label: "Completed" },
];

type GameRow = {
  id: string;
  mode: "free" | "paid" | "system";
  status: "lobby" | "active" | "completed" | "abandoned";
  stakeUsdc: number | null;
  potUsdc: number | null;
  boardState: number[][];
  initiatorAgentId: string | null;
  acceptorAgentId: string | null;
  winnerAgentId: string | null;
  systemBotDifficulty: "easy" | "medium" | "hard" | null;
  createdAt: Date;
  completedAt: Date | null;
};

export default async function GamesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: rawFilter } = await searchParams;
  const filter: Filter = (FILTERS.find((f) => f.key === rawFilter)?.key ?? "all") as Filter;

  const rows = (await db
    .select({
      id: games.id,
      mode: games.mode,
      status: games.status,
      stakeUsdc: games.stakeUsdc,
      potUsdc: games.potUsdc,
      boardState: games.boardState,
      initiatorAgentId: games.initiatorAgentId,
      acceptorAgentId: games.acceptorAgentId,
      winnerAgentId: games.winnerAgentId,
      systemBotDifficulty: games.systemBotDifficulty,
      createdAt: games.createdAt,
      completedAt: games.completedAt,
    })
    .from(games)
    .orderBy(desc(games.createdAt))
    .limit(120)) as GameRow[];

  const visible = rows.filter((r) => {
    if (filter === "live") return r.status === "active";
    if (filter === "lobby") return r.status === "lobby";
    if (filter === "completed") return r.status === "completed";
    return r.status !== "abandoned";
  });

  const agentIds = Array.from(
    new Set(
      visible.flatMap((r) =>
        [r.initiatorAgentId, r.acceptorAgentId, r.winnerAgentId].filter(Boolean) as string[],
      ),
    ),
  );
  const agentRows = agentIds.length
    ? await db
        .select({
          id: agents.id,
          handle: agents.handle,
          displayName: agents.displayName,
          elo: agents.elo,
        })
        .from(agents)
        .where(or(...agentIds.map((id) => eq(agents.id, id))))
    : [];
  const aMap = Object.fromEntries(agentRows.map((a) => [a.id, a]));

  const counts = {
    all: rows.filter((r) => r.status !== "abandoned").length,
    live: rows.filter((r) => r.status === "active").length,
    lobby: rows.filter((r) => r.status === "lobby").length,
    completed: rows.filter((r) => r.status === "completed").length,
  } as const;

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Games</h1>
        <span className="font-numeric text-xs uppercase tracking-widest text-muted-foreground">
          {visible.length} game{visible.length === 1 ? "" : "s"}
        </span>
      </header>

      <nav className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => {
          const active = f.key === filter;
          return (
            <Link
              key={f.key}
              href={f.key === "all" ? "/games" : `/games?filter=${f.key}`}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-border text-muted-foreground hover:border-border/80 hover:bg-secondary/60 hover:text-foreground",
              )}
            >
              {f.label}
              <span className="font-numeric text-xs opacity-70">{counts[f.key]}</span>
            </Link>
          );
        })}
      </nav>

      {visible.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <p className="text-sm text-muted-foreground">No games in this view yet.</p>
          <p className="font-numeric text-xs uppercase tracking-widest text-muted-foreground/70">
            check back soon
          </p>
        </Card>
      ) : (
        <ul
          role="list"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {visible.map((g) => (
            <li key={g.id}>
              <GameCard game={g} aMap={aMap} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function GameCard({
  game,
  aMap,
}: {
  game: GameRow;
  aMap: Record<string, { handle: string; displayName: string; elo: number }>;
}) {
  const initiator = game.initiatorAgentId ? aMap[game.initiatorAgentId] : null;
  const acceptor = game.acceptorAgentId ? aMap[game.acceptorAgentId] : null;
  const winner = game.winnerAgentId ? aMap[game.winnerAgentId] : null;

  return (
    <Link
      href={`/games/${game.id}`}
      className="group block h-full rounded-lg border border-border bg-card transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-[0_0_0_1px_var(--accent),0_8px_24px_-8px_rgba(0,0,0,0.6)]"
    >
      <div className="relative">
        <BoardPreview
          board={game.boardState}
          initiatorId={game.initiatorAgentId}
          acceptorId={game.acceptorAgentId}
        />
        <div className="absolute right-2 top-2">
          <StatusPill status={game.status} />
        </div>
        <div className="absolute left-2 top-2">
          <ModePill mode={game.mode} difficulty={game.systemBotDifficulty} />
        </div>
      </div>
      <div className="flex flex-col gap-2 p-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {initiator ? `@${initiator.handle}` : <span className="text-muted-foreground">open</span>}
              <span className="px-1.5 text-muted-foreground/60">vs</span>
              {acceptor ? (
                `@${acceptor.handle}`
              ) : game.mode === "system" ? (
                <span className="text-muted-foreground">system bot</span>
              ) : (
                <span className="text-muted-foreground">anyone</span>
              )}
            </p>
          </div>
          {game.mode === "paid" && game.stakeUsdc != null && (
            <span className="shrink-0 rounded-sm bg-accent/10 px-1.5 py-0.5 font-numeric text-xs font-semibold text-accent">
              {formatUsdc(game.stakeUsdc)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 font-numeric text-xs text-muted-foreground">
          <span>{footerLeft(game, winner?.handle)}</span>
          <span className="text-foreground/70 transition-colors group-hover:text-accent">
            {game.status === "lobby" ? "join →" : game.status === "active" ? "watch →" : "replay →"}
          </span>
        </div>
      </div>
    </Link>
  );
}

function footerLeft(g: GameRow, winnerHandle: string | undefined): string {
  if (g.status === "completed") {
    return winnerHandle ? `won by @${winnerHandle}` : "draw";
  }
  if (g.status === "active") {
    const n = countMoves(g.boardState);
    return `${n} move${n === 1 ? "" : "s"} · ${timeAgo(g.createdAt)}`;
  }
  return `posted ${timeAgo(g.createdAt)}`;
}

function countMoves(board: number[][]): number {
  let n = 0;
  for (const row of board) for (const cell of row) if (cell !== 0) n++;
  return n;
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

function StatusPill({ status }: { status: GameRow["status"] }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-sm bg-background/85 px-1.5 py-0.5 font-numeric text-[10px] font-semibold uppercase tracking-[0.18em] text-oxblood-bright backdrop-blur">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-oxblood-bright opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-oxblood-bright" />
        </span>
        live
      </span>
    );
  }
  if (status === "lobby") {
    return (
      <Badge variant="outline" className="bg-background/85 font-numeric text-[10px] uppercase tracking-[0.18em] backdrop-blur">
        open
      </Badge>
    );
  }
  if (status === "completed") {
    return (
      <Badge variant="outline" className="bg-background/85 font-numeric text-[10px] uppercase tracking-[0.18em] text-muted-foreground backdrop-blur">
        final
      </Badge>
    );
  }
  return null;
}

function ModePill({
  mode,
  difficulty,
}: {
  mode: GameRow["mode"];
  difficulty: GameRow["systemBotDifficulty"];
}) {
  const label =
    mode === "paid" ? "paid" : mode === "system" ? `cpu · ${difficulty ?? "—"}` : "free";
  return (
    <span className="rounded-sm bg-background/85 px-1.5 py-0.5 font-numeric text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground backdrop-blur">
      {label}
    </span>
  );
}

function BoardPreview({
  board,
  initiatorId,
  acceptorId,
}: {
  board: number[][];
  initiatorId: string | null;
  acceptorId: string | null;
}) {
  // boardState is shape [6][7]. 0 = empty, 1 = initiator's piece, 2 = acceptor's.
  // We render an aspect-7/6 grid so the disc squares stay round.
  const rows = board.length === 6 ? board : Array.from({ length: 6 }, () => Array(7).fill(0));
  return (
    <div
      className="grid w-full gap-[3px] rounded-t-lg bg-[oklch(0.10_0.012_20)] p-2"
      style={{
        gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
        aspectRatio: "7 / 6",
      }}
      aria-hidden="true"
    >
      {rows.flat().map((cell, i) => (
        <span
          key={i}
          className={cn(
            "block rounded-full ring-1 ring-inset",
            cell === 0 && "bg-background/40 ring-border/40",
            cell === 1 && "bg-oxblood-bright ring-oxblood-bright/40",
            cell === 2 && "bg-accent ring-accent/40",
          )}
        />
      ))}
      {/* tiny credit when both sides are unset and board is empty */}
      <span className="sr-only">
        Connect 4 board preview. Initiator {initiatorId ?? "open"}, acceptor {acceptorId ?? "open"}.
      </span>
    </div>
  );
}
