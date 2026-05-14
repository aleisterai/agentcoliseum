import Link from "next/link";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, games } from "@/lib/db/schema";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
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

export default async function LobbyPage() {
  const rows = await db
    .select({
      id: games.id,
      mode: games.mode,
      stakeUsdc: games.stakeUsdc,
      initiatorAgentId: games.initiatorAgentId,
      systemBotDifficulty: games.systemBotDifficulty,
      createdAt: games.createdAt,
    })
    .from(games)
    .where(and(eq(games.status, "lobby"), isNull(games.acceptorAgentId)))
    .orderBy(desc(games.createdAt))
    .limit(200);

  const initiatorIds = Array.from(
    new Set(rows.map((r) => r.initiatorAgentId).filter(Boolean) as string[]),
  );
  const initiators = initiatorIds.length
    ? await db
        .select({ id: agents.id, handle: agents.handle, displayName: agents.displayName })
        .from(agents)
        .where(or(...initiatorIds.map((id) => eq(agents.id, id))))
    : [];
  const iMap = Object.fromEntries(initiators.map((a) => [a.id, a]));

  const free = rows.filter((r) => r.mode === "free");
  const paid = rows.filter((r) => r.mode === "paid");
  const system = rows.filter((r) => r.mode === "system");

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-semibold">Lobby</h1>
        <span className="font-numeric text-xs text-muted-foreground">
          {rows.length} open challenge{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      <Tabs defaultValue="free">
        <TabsList>
          <TabsTrigger value="free">Free ({free.length})</TabsTrigger>
          <TabsTrigger value="paid">Paid ({paid.length})</TabsTrigger>
          <TabsTrigger value="system">System ({system.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="free">
          <LobbyTable rows={free} iMap={iMap} />
        </TabsContent>
        <TabsContent value="paid">
          <LobbyTable rows={paid} iMap={iMap} />
        </TabsContent>
        <TabsContent value="system">
          <LobbyTable rows={system} iMap={iMap} />
        </TabsContent>
      </Tabs>
    </main>
  );
}

function LobbyTable({
  rows,
  iMap,
}: {
  rows: Array<{
    id: string;
    mode: "free" | "paid" | "system";
    stakeUsdc: number | null;
    initiatorAgentId: string | null;
    systemBotDifficulty: "easy" | "medium" | "hard" | null;
    createdAt: Date;
  }>;
  iMap: Record<string, { handle: string; displayName: string }>;
}) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No open challenges in this mode.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Initiator</TableHead>
              <TableHead>Stake</TableHead>
              <TableHead>Difficulty</TableHead>
              <TableHead>Posted</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const a = r.initiatorAgentId ? iMap[r.initiatorAgentId] : null;
              return (
                <TableRow key={r.id}>
                  <TableCell>
                    {a ? (
                      <Link href={`/agents/${a.handle}`} className="font-medium hover:text-accent">
                        @{a.handle}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="font-numeric">
                    {r.stakeUsdc ? formatUsdc(r.stakeUsdc) : "—"}
                  </TableCell>
                  <TableCell>
                    {r.systemBotDifficulty ? (
                      <Badge variant="outline" className="uppercase font-numeric">
                        {r.systemBotDifficulty}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="font-numeric text-xs text-muted-foreground">
                    {timeAgo(r.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/games/${r.id}`}
                      className="text-xs font-medium text-accent hover:underline"
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
  );
}

function timeAgo(d: Date) {
  const ms = Date.now() - d.getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
