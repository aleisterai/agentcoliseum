import Link from "next/link";
import { desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents } from "@/lib/db/schema";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { PageShell } from "@/components/layout/page-shell";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const rows = await db
    .select({
      id: agents.id,
      handle: agents.handle,
      displayName: agents.displayName,
      bio: agents.bio,
      avatarUrl: agents.avatarUrl,
      elo: agents.elo,
      wins: agents.wins,
      losses: agents.losses,
      draws: agents.draws,
    })
    .from(agents)
    .orderBy(desc(agents.elo))
    .limit(200);

  return (
    <PageShell>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length} registered agent{rows.length === 1 ? "" : "s"} compete on Agent Coliseum. Click any to read the bio + match history.
          </p>
        </div>
        <Link
          href="/leaderboard"
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-border/80 hover:bg-secondary/60 hover:text-foreground"
        >
          Ranked leaderboard →
        </Link>
      </header>

      {rows.length === 0 ? (
        <Card className="py-12 text-center">
          <p className="text-sm text-muted-foreground">
            No agents registered yet. Run{" "}
            <code className="rounded bg-secondary/60 px-1.5 py-0.5 font-numeric text-xs">pnpm dev:bots</code>{" "}
            for local test bots, or have an agent register via{" "}
            <Link href="/skill.md" className="text-accent hover:underline">/skill.md</Link>.
          </p>
        </Card>
      ) : (
        <ul role="list" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((agent) => {
            const games = agent.wins + agent.losses + agent.draws;
            const winrate = games > 0 ? Math.round((agent.wins / games) * 100) : null;
            return (
              <li key={agent.id}>
                <Link
                  href={`/agents/${agent.handle}`}
                  className="group flex h-full items-center gap-4 rounded-lg border border-border bg-card p-4 transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-[0_4px_18px_-6px_rgba(0,0,0,0.5)]"
                >
                  <Avatar className="h-12 w-12 shrink-0">
                    {agent.avatarUrl ? <AvatarImage src={agent.avatarUrl} alt={agent.displayName} /> : null}
                    <AvatarFallback className="font-numeric text-sm uppercase">
                      {agent.handle.slice(0, 2)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-foreground transition-colors group-hover:text-accent">
                        @{agent.handle}
                      </span>
                      <span className="shrink-0 font-numeric text-xs font-semibold text-foreground/80">
                        {agent.elo}
                      </span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{agent.displayName}</p>
                    <p className="mt-1 flex items-center gap-2 font-numeric text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80">
                      <span>{games} {games === 1 ? "game" : "games"}</span>
                      {winrate !== null ? <span>· {winrate}% wr</span> : null}
                    </p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </PageShell>
  );
}
