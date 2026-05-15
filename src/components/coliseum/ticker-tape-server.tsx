/**
 * TickerTapeServer — async server component that builds the tape items
 * from the live DB: completed matches (WINs), active matches (LIVE),
 * posted challenges (OPEN). Falls back to a static set when the DB is empty.
 */
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, challenges, matches } from "@/lib/db/schema";
import { TickerTape, type TickerItem } from "./ticker-tape";

async function buildItems(): Promise<TickerItem[]> {
  const [completed, live, posted] = await Promise.all([
    db
      .select({
        id: matches.id,
        winnerAgentId: matches.winnerAgentId,
        gameType: matches.gameType,
        potUsdc: matches.potUsdc,
        stakeUsdc: matches.stakeUsdc,
        p1EloDelta: matches.p1EloDelta,
        p2EloDelta: matches.p2EloDelta,
      })
      .from(matches)
      .where(eq(matches.status, "completed"))
      .orderBy(desc(matches.completedAt))
      .limit(6),
    db
      .select({
        id: matches.id,
        p1AgentId: matches.p1AgentId,
        p2AgentId: matches.p2AgentId,
        gameType: matches.gameType,
        potUsdc: matches.potUsdc,
      })
      .from(matches)
      .where(eq(matches.status, "active"))
      .orderBy(desc(matches.lastMoveAt))
      .limit(4),
    db
      .select({
        id: challenges.id,
        initiatorAgentId: challenges.initiatorAgentId,
        gameType: challenges.gameType,
        stakeUsdc: challenges.stakeUsdc,
      })
      .from(challenges)
      .where(eq(challenges.status, "posted"))
      .orderBy(desc(challenges.postedAt))
      .limit(3),
  ]);

  const agentIds = Array.from(
    new Set(
      [
        ...completed.map((g) => g.winnerAgentId),
        ...live.flatMap((g) => [g.p1AgentId, g.p2AgentId]),
        ...posted.map((g) => g.initiatorAgentId),
      ].filter(Boolean) as string[],
    ),
  );
  const handleMap = new Map<string, string>();
  if (agentIds.length) {
    const rows = await db.select({ id: agents.id, handle: agents.handle }).from(agents);
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
      game: prettify(g.gameType),
      pot: g.potUsdc ?? g.stakeUsdc ?? 0,
      dElo: Math.abs(g.p1EloDelta ?? g.p2EloDelta ?? 10),
    });
  }
  for (const g of live) {
    const a = handleOf(g.p1AgentId);
    const b = handleOf(g.p2AgentId);
    if (!a || !b) continue;
    items.push({ kind: "match", handle: a, opponent: b, game: prettify(g.gameType), pot: g.potUsdc ?? undefined });
  }
  for (const g of posted) {
    const h = handleOf(g.initiatorAgentId);
    if (!h) continue;
    items.push({ kind: "challenge", handle: h, game: prettify(g.gameType), stake: g.stakeUsdc ?? 0 });
  }
  return items;
}

function prettify(slug: string): string {
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

const FALLBACK: TickerItem[] = [
  { kind: "vol", game: "Connect 4", vol: "1.2k USDC / 24h" },
  { kind: "challenge", handle: "bot-alpha", game: "Connect 4", stake: 100_000 },
  { kind: "match", handle: "bot-beta", opponent: "bot-gamma", game: "Connect 4" },
];

export async function TickerTapeServer() {
  const items = await buildItems().catch(() => [] as TickerItem[]);
  return <TickerTape items={items.length ? items : FALLBACK} />;
}
