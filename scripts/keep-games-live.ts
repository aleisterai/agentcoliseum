/**
 * keep-games-live.ts — local dev helper that keeps the lobby busy with
 * bot-vs-bot matches on the Wave-0 lifecycle (matches table, applyMove,
 * finalizeMatch).
 *
 *   1. Ensures a synthetic owner + a fixed pool of 5 test bots
 *   2. For every registered adapter, keeps TARGET active matches running
 *      between random pairs of bots
 *   3. Drives moves through applyMove() (not the HTTP route — bypasses
 *      x402 / tier / Privy)
 *
 * Run:  pnpm dev:bots
 */
import { randomBytes } from "node:crypto";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches, owners } from "@/lib/db/schema";
import { ADAPTERS } from "@/lib/game/registry";
import { buildEngine } from "@/lib/game/engine";
import { applyMove } from "@/lib/game/server-flow";
import { broadcastLobby, realtimeEvent } from "@/lib/realtime";
import type { GameAdapter, BotDifficulty } from "@/lib/game/types";

// Tick every 5s and keep 3 active matches per game type. 14 games × 3
// ≈ 42 active matches — populates every game's "Live now" rail across
// the homepage and lobby views. Matches are driven in parallel across
// adapters AND across matches within an adapter (Promise.all) — without
// that, serial 42-match processing per tick burns wall-clock against the
// 5-min clock budget and games forfeit on time before they can finish.
// With pool=10 (Sprint 16 tuning) the dev server breathes fine alongside
// 42 concurrent bot writes.
const TICK_MS = 5000;
const TARGET_LIVE_PER_GAMETYPE = 3;
const TEST_OWNER_WALLET = "0xb010b010b010b010b010b010b010b010b010b010";
const BOT_HANDLES = ["bot-alpha", "bot-beta", "bot-gamma", "bot-delta", "bot-epsilon"];
const DIFFICULTIES: BotDifficulty[] = ["easy", "medium", "hard"];

let stopping = false;

async function main() {
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL missing — make sure .env.local is in the project root.");
  }

  console.log(`[bots] starting. ${ADAPTERS.length} live adapter(s): ${ADAPTERS.map((a) => a.id).join(", ")}`);
  await ensureTestBots();
  const bots = await loadBots();
  console.log(`[bots] pool: ${bots.map((b) => "@" + b.handle).join(", ")}`);
  console.log(`[bots] tick every ${TICK_MS}ms, target ${TARGET_LIVE_PER_GAMETYPE} active per game. ctrl+c to stop.`);

  while (!stopping) {
    try {
      await tick(bots);
    } catch (err) {
      console.error("[bots] tick error:", err instanceof Error ? err.message : err);
    }
    await sleep(TICK_MS);
  }
  console.log("[bots] stopped.");
  process.exit(0);
}

function onSignal(sig: string) {
  if (stopping) {
    console.log(`[bots] forcing exit on ${sig}`);
    process.exit(1);
  }
  stopping = true;
  console.log(`\n[bots] caught ${sig}, finishing current tick…`);
}

async function ensureTestBots() {
  let owner = await db.query.owners.findFirst({ where: eq(owners.walletAddress, TEST_OWNER_WALLET) });
  if (!owner) {
    [owner] = await db
      .insert(owners)
      .values({
        walletAddress: TEST_OWNER_WALLET,
        apiKey: "ack_dev_" + randomBytes(16).toString("hex"),
      })
      .returning();
    console.log("[bots] created synthetic owner", owner.id);
  }
  for (const handle of BOT_HANDLES) {
    const existing = await db.query.agents.findFirst({ where: eq(agents.handle, handle) });
    if (existing) continue;
    const displayName = handle.replace("bot-", "").replace(/^./, (c) => c.toUpperCase());
    await db.insert(agents).values({
      ownerId: owner.id,
      handle,
      displayName: `${displayName} Bot`,
      bio: "Test bot for local development. Plays random difficulty against other bots to keep the lobby busy.",
      elo: 1200,
      apiKey: "ack_dev_" + handle + "_" + randomBytes(8).toString("hex"),
    });
    console.log("[bots] created", handle);
  }
}

async function loadBots() {
  return db
    .select({ id: agents.id, handle: agents.handle })
    .from(agents)
    .where(inArray(agents.handle, BOT_HANDLES));
}

type Bot = { id: string; handle: string };

async function tick(bots: Bot[]) {
  if (bots.length < 2) {
    console.warn("[bots] need at least 2 bots, have", bots.length);
    return;
  }
  const botIds = new Set(bots.map((b) => b.id));

  // Iterate adapters sequentially, but parallelize the per-adapter move
  // drives with Promise.all. Going fully parallel across adapters (14
  // simultaneous SELECTs + 42 fan-out driveBotMoves) overflows the
  // Supabase transaction-mode pooler's statement-timeout queue. Per-
  // adapter parallel gives ~3 concurrent moves at any moment — fast
  // enough to clear a 42-match backlog in ~5-6s while staying under
  // the pool ceiling.
  for (const adapter of ADAPTERS) {
    if (stopping) return;
    const active = await db
      .select({
        id: matches.id,
        currentTurnAgentId: matches.currentTurnAgentId,
        currentTurnPlayerId: matches.currentTurnPlayerId,
      })
      .from(matches)
      .where(and(eq(matches.gameType, adapter.id), eq(matches.status, "active")));

    // Drive bot moves on this adapter's matches concurrently.
    await Promise.all(
      active.map(async (m) => {
        if (stopping) return;
        if (!m.currentTurnAgentId || !botIds.has(m.currentTurnAgentId)) return;
        await driveBotMove(
          adapter,
          m.id,
          m.currentTurnAgentId,
          m.currentTurnPlayerId,
          bots,
        );
      }),
    );

    // Top up to target. Sequential is fine here — spawns are cheap
    // and we don't want to over-create if the in-flight create races.
    const need = Math.max(0, TARGET_LIVE_PER_GAMETYPE - active.length);
    for (let i = 0; i < need; i++) {
      if (stopping) return;
      await spawnMatch(adapter, bots);
    }
  }
}

async function spawnMatch(adapter: GameAdapter, bots: Bot[]) {
  const [a, b] = pickTwoDistinct(bots);
  const engine = buildEngine(adapter.game);
  const initial = engine.initialState();
  const [created] = await db
    .insert(matches)
    .values({
      gameType: adapter.id,
      mode: "free",
      p1AgentId: a.id,
      p2AgentId: b.id,
      systemBotDifficulty: null,
      state: initial as unknown as object,
      status: "active",
      currentTurnPlayerId: "0",
      currentTurnAgentId: a.id,
      turnStartedAt: new Date(),
      p1MsLeft: adapter.clockBudgetMs,
      p2MsLeft: adapter.clockBudgetMs,
      clockBudgetMs: adapter.clockBudgetMs,
      startedAt: new Date(),
    })
    .returning();
  await broadcastLobby(realtimeEvent.GameCreated, {
    id: created.id,
    gameType: adapter.id,
    mode: "free",
  });
  console.log(`[bots] spawn ${adapter.id} ${created.id.slice(0, 8)} — @${a.handle} vs @${b.handle}`);
}

async function driveBotMove(
  adapter: GameAdapter,
  matchId: string,
  agentId: string,
  playerId: "0" | "1",
  bots: Bot[],
) {
  const match = await db.query.matches.findFirst({ where: eq(matches.id, matchId) });
  if (!match || match.status !== "active") return;
  const state = match.state as { G: unknown };
  const difficulty = pickRandom(DIFFICULTIES);
  const bot = adapter.bots[difficulty];
  const moveValue = bot.pickMove(state.G as never, playerId);
  const payload = wrapMovePayload(adapter, moveValue);
  try {
    const updated = await applyMove({
      matchId,
      agentId,
      payload,
      thinkingMs: 300 + Math.floor(Math.random() * 2500),
    });
    if (updated.status === "completed") {
      const winnerId = updated.winnerAgentId;
      const winnerLabel = winnerId
        ? "@" + (bots.find((b) => b.id === winnerId)?.handle ?? winnerId.slice(0, 8))
        : "draw";
      console.log(`[bots] done   ${adapter.id} ${matchId.slice(0, 8)} — ${winnerLabel} (${updated.resultReason})`);
    }
  } catch (err) {
    console.error(
      `[bots] move ${adapter.id} ${matchId.slice(0, 8)} by @${bots.find((b) => b.id === agentId)?.handle ?? agentId.slice(0, 8)} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

function wrapMovePayload(adapter: GameAdapter, raw: unknown): unknown {
  switch (adapter.id) {
    case "connect4":
      return { column: raw };
    case "tic-tac-toe":
      return { index: raw };
    case "chess":
    case "checkers":
    case "reversi":
    case "gomoku":
    case "dots-and-boxes":
    case "mancala":
    case "nine-mens-morris":
    case "nim":
    case "hex":
    case "quoridor":
    case "santorini":
    case "tak":
      // These bots already return the full payload shape — pass through.
      return raw;
    default:
      return raw;
  }
}

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickTwoDistinct<T>(arr: T[]): [T, T] {
  if (arr.length < 2) throw new Error("need at least 2");
  const i = Math.floor(Math.random() * arr.length);
  let j = Math.floor(Math.random() * (arr.length - 1));
  if (j >= i) j++;
  return [arr[i], arr[j]];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error("[bots] fatal:", e);
  process.exit(1);
});
