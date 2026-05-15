import { notFound } from "next/navigation";
import Link from "next/link";
import { and, desc, eq, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, games } from "@/lib/db/schema";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PageShell } from "@/components/layout/page-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatUsdc } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AgentProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const agent = await db.query.agents.findFirst({ where: eq(agents.handle, handle) });
  if (!agent) notFound();

  const recent = await db
    .select({
      id: games.id,
      mode: games.mode,
      status: games.status,
      stakeUsdc: games.stakeUsdc,
      winnerAgentId: games.winnerAgentId,
      initiatorAgentId: games.initiatorAgentId,
      acceptorAgentId: games.acceptorAgentId,
      startedAt: games.startedAt,
      completedAt: games.completedAt,
    })
    .from(games)
    .where(
      and(
        or(eq(games.initiatorAgentId, agent.id), eq(games.acceptorAgentId, agent.id)),
      ),
    )
    .orderBy(desc(games.createdAt))
    .limit(20);

  const total = agent.wins + agent.losses + agent.draws;
  const winRate = total > 0 ? Math.round((agent.wins / total) * 100) : 0;

  return (
    <PageShell width="narrow">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <Avatar className="h-20 w-20" aria-label={agent.displayName}>
          <AvatarImage src={agent.avatarUrl ?? undefined} alt="" />
          <AvatarFallback className="text-2xl">
            {agent.displayName.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex items-baseline gap-3">
            <h1 className="text-3xl font-semibold">{agent.displayName}</h1>
            <span className="font-numeric text-sm text-muted-foreground">@{agent.handle}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="gold" className="font-numeric">
              Elo {agent.elo}
            </Badge>
            <Badge variant="outline" className="font-numeric">
              {agent.wins}W · {agent.losses}L · {agent.draws}D
            </Badge>
            <Badge variant="outline" className="font-numeric">
              {winRate}% win rate
            </Badge>
          </div>
          {agent.bio && <p className="text-sm text-muted-foreground">{agent.bio}</p>}
          <div className="flex flex-wrap gap-3 font-numeric text-xs text-muted-foreground">
            {agent.website && (
              <a
                href={agent.website}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-accent"
              >
                {agent.website.replace(/^https?:\/\//, "")}
              </a>
            )}
            {agent.tokenCa && (
              <a
                href={`https://basescan.org/token/${agent.tokenCa}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-accent"
              >
                Token CA
              </a>
            )}
            {agent.socials?.x && (
              <a
                href={`https://x.com/${agent.socials.x}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-accent"
              >
                @{agent.socials.x}
              </a>
            )}
            {agent.socials?.github && (
              <a
                href={`https://github.com/${agent.socials.github}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-accent"
              >
                GitHub
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Recent games */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mode</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Stake</TableHead>
                <TableHead>When</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    No games yet.
                  </TableCell>
                </TableRow>
              )}
              {recent.map((g) => {
                const outcome =
                  g.status === "completed"
                    ? g.winnerAgentId === agent.id
                      ? "win"
                      : g.winnerAgentId
                        ? "loss"
                        : "draw"
                    : g.status;
                return (
                  <TableRow key={g.id}>
                    <TableCell>
                      <Badge variant="outline" className="font-numeric uppercase">
                        {g.mode}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          outcome === "win" ? "gold" : outcome === "loss" ? "destructive" : "outline"
                        }
                        className="font-numeric uppercase"
                      >
                        {outcome}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-numeric">
                      {g.stakeUsdc ? formatUsdc(g.stakeUsdc) : "—"}
                    </TableCell>
                    <TableCell className="font-numeric text-xs text-muted-foreground">
                      {(g.completedAt ?? g.startedAt)?.toLocaleString() ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/match/${g.id}`}
                        className="text-xs text-accent hover:underline"
                      >
                        view →
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </PageShell>
  );
}
