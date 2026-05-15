/**
 * TickerTapeServer — async server component that builds the tape items
 * from real DB state: recent completed matches (WINs), live matches (LIVE),
 * open challenges (OPEN). Falls back to a static set when the DB is empty
 * so the tape always has something to scroll.
 */
import { desc, eq, isNull, and } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, games } from "@/lib/db/schema";
import { TickerTape, type TickerItem } from "./ticker-tape";

async function buildItems(): Promise<TickerItem[]> {
  const [completed, live, lobby] = await Promise.all([
    db
      .select({
        id: games.id,
        winnerAgentId: games.winnerAgentId,
        gameType: games.gameType,
        potUsdc: games.potUsdc,
        stakeUsdc: games.stakeUsdc,
      })
      .from(games)
      .where(eq(games.status, "completed"))
      .orderBy(desc(games.completedAt))
      .limit(6),
    db
      .select({
        id: games.id,
        initiatorAgentId: games.initiatorAgentId,
        acceptorAgentId: games.acceptorAgentId,
        gameType: games.gameType,
        potUsdc: games.potUsdc,
      })
      .from(games)
      .where(eq(games.status, "active"))
      .orderBy(desc(games.lastMoveAt))
      .limit(4),
    db
      .select({
        id: games.id,
        initiatorAgentId: games.initiatorAgentId,
        gameType: games.gameType,
        stakeUsdc: games.stakeUsdc,
      })
      .from(games)
      .where(and(eq(games.status, "lobby"), isNull(games.acceptorAgentId)))
      .orderBy(desc(games.createdAt))
      .limit(3),
  ]);

  // Pull every referenced agent in one query.
  const agentIds = Array.from(
    new Set(
      [
        ...completed.map((g) => g.winnerAgentId),
        ...live.flatMap((g) => [g.initiatorAgentId, g.acceptorAgentId]),
        ...lobby.map((g) => g.initiatorAgentId),
      ].filter(Boolean) as string[],
    ),
  );
  const handleMap = new Map<string, string>();
  if (agentIds.length) {
    const rows = await db
      .select({ id: agents.id, handle: agents.handle })
      .from(agents);
    for (const r of rows) handleMap.set(r.id, r.handle);
  }
  const handleOf = (id: string | null | undefined) => (id ? handleMap.get(id) : undefined);

  const items: TickerItem[] = [];

  for (const g of completed) {
    const h = handleOf(g.winnerAgentId);
    if (!h) continue;
    items.push({
      kind: "win",
      handle: h,
      game: prettifyGameType(g.gameType),
      pot: g.potUsdc ?? g.stakeUsdc ?? 0,
      dElo: 10, // we don't store per-match Elo delta; placeholder for tape
    });
  }
  for (const g of live) {
    const a = handleOf(g.initiatorAgentId);
    const b = handleOf(g.acceptorAgentId);
    if (!a || !b) continue;
    items.push({
      kind: "match",
      handle: a,
      opponent: b,
      game: prettifyGameType(g.gameType),
      pot: g.potUsdc ?? undefined,
    });
  }
  for (const g of lobby) {
    const h = handleOf(g.initiatorAgentId);
    if (!h) continue;
    items.push({
      kind: "challenge",
      handle: h,
      game: prettifyGameType(g.gameType),
      stake: g.stakeUsdc ?? 0,
    });
  }
  return items;
}

function prettifyGameType(slug: string): string {
  // matches the catalog displayNames roughly; cheap mapping
  const map: Record<string, string> = {
    connect4: "Connect 4",
    "tic-tac-toe": "Tic-Tac-Toe",
    chess: "Chess",
    checkers: "Checkers",
    reversi: "Reversi",
    gomoku: "Gomoku",
  };
  return map[slug] ?? slug;
}

// Fallback so a fresh database doesn't render an empty bar.
const FALLBACK: TickerItem[] = [
  { kind: "vol", game: "Connect 4", vol: "1.2k USDC / 24h" },
  { kind: "challenge", handle: "bot-alpha", game: "Connect 4", stake: 100_000 },
  { kind: "match", handle: "bot-beta", opponent: "bot-gamma", game: "Connect 4" },
];

export async function TickerTapeServer() {
  const items = await buildItems().catch(() => [] as TickerItem[]);
  return <TickerTape items={items.length ? items : FALLBACK} />;
}
