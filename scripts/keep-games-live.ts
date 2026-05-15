/**
 * keep-games-live.ts — local dev helper that keeps the lobby busy with
 * bot-vs-bot matches so you can test mechanics, spectator UI, and replays
 * without manually creating games.
 *
 * What it does:
 *   1. Creates a small fixed pool of test agents (bot-alpha, bot-beta, ...)
 *      under one synthetic owner. Owner has a placeholder wallet; the
 *      script bypasses tier checks by writing directly to the DB.
 *   2. For every live GameAdapter in the registry, maintains TARGET active
 *      games at all times. When a game ends, a new one spawns on the next
 *      tick.
 *   3. On each tick, drives moves for all active bot games using the
 *      adapter's own bots (random difficulty per move for variety).
 *
 * Run:    pnpm dev:bots
 * Stop:   Ctrl+C
 */

// Env is loaded by the npm script wrapper (`node --env-file=.env.local …`).
// ESM imports are hoisted, so anything that reads process.env at module-init
// time would fire before a top-level dotenv.config() call could land.
import { randomBytes } from "node:crypto";
import { eq, and, inArray, desc } from "drizzle-orm";
import type { State } from "boardgame.io";
import { db } from "@/lib/db/client";
import { agents, games, owners, type Agent } from "@/lib/db/schema";
import { ADAPTERS } from "@/lib/game/registry";
import { buildEngine } from "@/lib/game/engine";
import { applyMoveTransaction } from "@/lib/game/server-flow";
import { broadcastLobby, realtimeEvent } from "@/lib/realtime";
import type { GameAdapter, BotDifficulty } from "@/lib/game/types";

const TICK_MS = 2500;
const TARGET_LIVE_PER_GAMETYPE = 3;

/**
 * Synthetic owner for all dev bots. Wallet address is a deterministic
 * placeholder so reruns find the same owner. Real wallets only on
 * production paths.
 */
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
  let owner = await db.query.owners.findFirst({
    where: eq(owners.walletAddress, TEST_OWNER_WALLET),
  });
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

  for (const adapter of ADAPTERS) {
    // Snapshot of active games for this adapter
    const active = await db
      .select({
        id: games.id,
        currentTurnAgentId: games.currentTurnAgentId,
        initiatorAgentId: games.initiatorAgentId,
        acceptorAgentId: games.acceptorAgentId,
      })
      .from(games)
      .where(and(eq(games.gameType, adapter.id), eq(games.status, "active")));

    // Drive a move for any game where it's one of our bots' turn
    for (const g of active) {
      if (!g.currentTurnAgentId || !botIds.has(g.currentTurnAgentId)) continue;
      await driveMove(adapter, g.id, g.currentTurnAgentId, bots);
      if (stopping) return;
    }

    // Top up to target
    const need = Math.max(0, TARGET_LIVE_PER_GAMETYPE - active.length);
    for (let i = 0; i < need; i++) {
      await spawnGame(adapter, bots);
      if (stopping) return;
    }
  }
}

async function spawnGame(adapter: GameAdapter, bots: Bot[]) {
  const [a, b] = pickTwoDistinct(bots);
  const engine = buildEngine(adapter.game);
  const initial = engine.initialState();
  const isConnect4 = adapter.id === "connect4";
  const legacyBoard = isConnect4
    ? ((initial.G as { board?: number[][] }).board ?? null)
    : null;

  const [created] = await db
    .insert(games)
    .values({
      gameType: adapter.id,
      mode: "free",
      status: "active",
      initiatorAgentId: a.id,
      acceptorAgentId: b.id,
      currentTurnAgentId: a.id,
      state: initial as unknown as object,
      ctx: (initial.ctx ?? null) as unknown as object,
      boardState: legacyBoard,
      startedAt: new Date(),
      lastMoveAt: new Date(),
    })
    .returning();

  await broadcastLobby(realtimeEvent.GameCreated, {
    id: created.id,
    mode: "free",
    gameType: adapter.id,
  });

  console.log(
    `[bots] spawn ${adapter.id} ${created.id.slice(0, 8)} — @${a.handle} vs @${b.handle}`,
  );
}

async function driveMove(adapter: GameAdapter, gameId: string, agentId: string, bots: Bot[]) {
  const game = await db.query.games.findFirst({ where: eq(games.id, gameId) });
  if (!game || game.status !== "active") return;
  const state = game.state as State<unknown>;
  const myPid: "0" | "1" = game.initiatorAgentId === agentId ? "0" : "1";

  // Pick a random difficulty so the games have variety + don't always run
  // the most expensive search.
  const difficulty = pickRandom(DIFFICULTIES);
  const bot = adapter.bots[difficulty];
  const moveValue = bot.pickMove((state.G as never), myPid);
  // Wrap into the validated payload shape the adapter expects.
  const payload = wrapMovePayload(adapter, moveValue);

  try {
    const updated = await applyMoveTransaction({
      gameId,
      agentId,
      payload,
      // Random "thinking time" 300–2800 ms so the spectator UI feels alive.
      thinkingMs: 300 + Math.floor(Math.random() * 2500),
    });
    if (updated.status === "completed") {
      const winnerId = updated.winnerAgentId;
      const winnerLabel = winnerId
        ? "@" + (bots.find((b) => b.id === winnerId)?.handle ?? winnerId.slice(0, 8))
        : "draw";
      console.log(`[bots] done   ${adapter.id} ${gameId.slice(0, 8)} — ${winnerLabel}`);
    }
  } catch (err) {
    console.error(
      `[bots] move ${adapter.id} ${gameId.slice(0, 8)} by @${bots.find((b) => b.id === agentId)?.handle ?? agentId.slice(0, 8)} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Bots return moves in whatever shape they like (Connect 4 returns a column
 * number, Chess will return `{ from, to }`, etc). The HTTP move endpoint
 * always sees an opaque JSON payload — wrap each game's raw move into the
 * matching API body so adapter.validateMovePayload accepts it.
 */
function wrapMovePayload(adapter: GameAdapter, raw: unknown): unknown {
  switch (adapter.id) {
    case "connect4":
      return { column: raw };
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
