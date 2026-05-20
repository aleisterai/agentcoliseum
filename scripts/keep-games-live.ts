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

// Keep 3 matches per game type alive (14 × 3 = 42) so every "Live now"
// rail on the homepage stays full. We tick every 1.5s — tic-tac-toe and
// nim both have a tight 60s-per-side clock, so with the 5s default tick
// each player only got 6-ish moves before timing out. At 1.5s the per-
// adapter parallel `Promise.all` lets us drive a side every ~3s, giving
// fast-clock games room to finish naturally. DB pool max is 10 (Sprint
// 16 tuning); per-adapter sequential keeps peak concurrent connections
// at ~3-4 even at the new cadence.
const TICK_MS = 1500;
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

// Max concurrent driveBotMove calls in flight. DB pool max=10; each
// driveBotMove holds 1-2 connections for the duration of its work
// (read match → engine.applyMove → update → broadcast). 6 leaves
// headroom for spawnMatch + the surrounding SELECT.
const MOVE_CONCURRENCY = 6;

const ADAPTER_BY_ID = new Map(ADAPTERS.map((a) => [a.id, a]));

async function tick(bots: Bot[]) {
  if (bots.length < 2) {
    console.warn("[bots] need at least 2 bots, have", bots.length);
    return;
  }
  const botIds = new Set(bots.map((b) => b.id));

  // One SELECT for the whole tick instead of 14 (one per adapter). The
  // prior per-adapter loop spent most of its wall-clock on serialized
  // round-trips, which inflated the move-to-move gap to ~30s — long
  // enough that nim/tic-tac-toe (60s-per-side clocks) ran out of time
  // before they could finish a real game.
  if (stopping) return;
  const active = await db
    .select({
      id: matches.id,
      gameType: matches.gameType,
      currentTurnAgentId: matches.currentTurnAgentId,
      currentTurnPlayerId: matches.currentTurnPlayerId,
    })
    .from(matches)
    .where(eq(matches.status, "active"));

  // Drive bot moves with bounded concurrency. Going fully parallel
  // (~42 concurrent SELECTs from each driveBotMove on top of broadcast
  // RPC) blew up the Supabase transaction-pooler statement timeout in
  // a prior attempt; 6 concurrent moves keeps us under the connection
  // pool ceiling.
  const queue = active.slice();
  await Promise.all(
    Array.from({ length: MOVE_CONCURRENCY }, async () => {
      while (queue.length > 0) {
        if (stopping) return;
        const m = queue.shift();
        if (!m) return;
        if (!m.currentTurnAgentId || !botIds.has(m.currentTurnAgentId)) continue;
        const adapter = ADAPTER_BY_ID.get(m.gameType);
        if (!adapter) continue;
        await driveBotMove(
          adapter,
          m.id,
          m.currentTurnAgentId,
          m.currentTurnPlayerId,
          bots,
        );
      }
    }),
  );

  // Top up to target — once per adapter, sequential. Cheap relative
  // to driveBotMove and lets us avoid over-creating on a race.
  const activeByGame = new Map<string, number>();
  for (const m of active) {
    activeByGame.set(m.gameType, (activeByGame.get(m.gameType) ?? 0) + 1);
  }
  for (const adapter of ADAPTERS) {
    if (stopping) return;
    const have = activeByGame.get(adapter.id) ?? 0;
    const need = Math.max(0, TARGET_LIVE_PER_GAMETYPE - have);
    for (let i = 0; i < need; i++) {
      if (stopping) return;
      await spawnMatch(adapter, bots);
    }
  }
}

// Rotate through the public clock presets so the lobby shows the full
// matrix of options the new dynamic-clock UI advertises.
const CLOCK_PRESETS_MS = [15_000, 30_000, 45_000, 60_000] as const;

async function spawnMatch(adapter: GameAdapter, bots: Bot[]) {
  const [a, b] = pickTwoDistinct(bots);
  const engine = buildEngine(adapter.game);
  const initial = engine.initialState();
  const perMoveMs = CLOCK_PRESETS_MS[Math.floor(Math.random() * CLOCK_PRESETS_MS.length)];
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
      p1MsLeft: perMoveMs,
      p2MsLeft: perMoveMs,
      clockBudgetMs: perMoveMs,
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
      // applyMove now requires non-empty reasoning. Harness bots don't
      // have an LLM attached so we synthesize a short heuristic line —
      // enough to populate the spectator reasoning timeline while making
      // it clear this is bot-generated thinking, not an agent.
      reasoning: syntheticReasoning(adapter.id, difficulty),
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

/**
 * Short canned reasoning line for a harness bot — gives the spectator
 * timeline something readable. Mixes a generic strategic phrase with a
 * search-depth tag so it doesn't look like the bot is faking LLM output.
 * Real agents that connect over MCP must publish their own reasoning;
 * applyMove rejects empty strings server-side.
 */
const SYNTHETIC_LINES: readonly string[] = [
  "Center control prioritized.",
  "Blocking opponent threat.",
  "Building toward 2-move tactic.",
  "Defending key square.",
  "Pressuring opponent territory.",
  "Maintaining tempo.",
  "Forced response sequence.",
  "Maximizing material balance.",
  "Setting up endgame structure.",
  "Trading favorable position.",
  "Cutting opponent options.",
  "Activating a piece.",
];
function syntheticReasoning(gameId: string, difficulty: BotDifficulty): string {
  const line = pickRandom(SYNTHETIC_LINES);
  const tag =
    difficulty === "hard"
      ? "depth-6 negamax"
      : difficulty === "medium"
        ? "depth-3 search"
        : "heuristic";
  return `${line} [${gameId} · ${tag}]`;
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
