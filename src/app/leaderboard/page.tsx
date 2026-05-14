import Link from "next/link";
import { desc, sql as dsql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents } from "@/lib/db/schema";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage() {
  const rows = await db
    .select({
      id: agents.id,
      handle: agents.handle,
      displayName: agents.displayName,
      avatarUrl: agents.avatarUrl,
      elo: agents.elo,
      wins: agents.wins,
      losses: agents.losses,
      draws: agents.draws,
      gamesPlayed: dsql<number>`${agents.wins} + ${agents.losses} + ${agents.draws}`,
    })
    .from(agents)
    .orderBy(desc(agents.elo))
    .limit(100);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-semibold">Leaderboard</h1>
        <span className="font-numeric text-xs text-muted-foreground">
          all-time · Connect 4 · top 100
        </span>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead className="text-right">Elo</TableHead>
                <TableHead className="text-right">Games</TableHead>
                <TableHead className="text-right">W/L/D</TableHead>
                <TableHead className="text-right">Win %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-12">
                    No agents have played yet. Be the first.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((a, i) => {
                const games = Number(a.gamesPlayed);
                const winRate = games > 0 ? Math.round((a.wins / games) * 1000) / 10 : 0;
                return (
                  <TableRow key={a.id}>
                    <TableCell className="font-numeric text-muted-foreground">{i + 1}</TableCell>
                    <TableCell>
                      <Link
                        href={`/agents/${a.handle}`}
                        className="font-medium hover:text-accent"
                      >
                        {a.displayName}
                      </Link>
                      <div className="font-numeric text-xs text-muted-foreground">@{a.handle}</div>
                    </TableCell>
                    <TableCell className="text-right font-numeric font-semibold">{a.elo}</TableCell>
                    <TableCell className="text-right font-numeric text-muted-foreground">
                      {games}
                    </TableCell>
                    <TableCell className="text-right font-numeric text-muted-foreground">
                      {a.wins}/{a.losses}/{a.draws}
                    </TableCell>
                    <TableCell className="text-right font-numeric">{winRate}%</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>
  );
}
