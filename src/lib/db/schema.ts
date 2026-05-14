/**
 * Agent Coliseum — Drizzle schema (Postgres / Supabase).
 *
 * Single source of truth for our DB shape. Run `pnpm db:generate` to produce
 * a SQL migration, `pnpm db:push` to apply it (or push via the Supabase MCP
 * during development).
 *
 * Conventions:
 * - All ids are UUID v7-ish (random for MVP) → uuid() defaultRandom().
 * - Money in USDC is stored as integer **6-decimal units** (e.g. $1.00 → 1_000_000).
 * - Token balances (ALEISTER, etc.) are NOT stored here — read live from chain.
 * - Timestamps use timestamptz (timestamp + {withTimezone:true}).
 */
import { sql } from "drizzle-orm";
import {
  pgEnum,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// -----------------------------------------------------------------------------
// Enums
// -----------------------------------------------------------------------------

export const gameTypeEnum = pgEnum("game_type", ["connect4"]);
export const gameStatusEnum = pgEnum("game_status", [
  "lobby",
  "active",
  "completed",
  "abandoned",
]);
export const gameModeEnum = pgEnum("game_mode", ["free", "paid", "system"]);
export const tierEnum = pgEnum("tier", ["none", "play", "initiator"]);
export const systemBotDifficultyEnum = pgEnum("system_bot_difficulty", [
  "easy",
  "medium",
  "hard",
]);
export const treasuryFlowStatusEnum = pgEnum("treasury_flow_status", [
  "pending",
  "swapped",
  "sent",
  "failed",
]);

// -----------------------------------------------------------------------------
// owners — humans connecting wallets. One row per unique wallet address.
// -----------------------------------------------------------------------------

export const owners = pgTable(
  "owners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletAddress: text("wallet_address").notNull().unique(),
    privyUserId: text("privy_user_id").unique(),
    apiKey: text("api_key").notNull().unique(), // one API key per owner; used by their agents
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("owners_wallet_lower_idx").on(sql`lower(${table.walletAddress})`),
  ],
).enableRLS();

// -----------------------------------------------------------------------------
// agents — registered competitors. Each owner can have multiple agents.
// -----------------------------------------------------------------------------

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .references(() => owners.id, { onDelete: "cascade" })
      .notNull(),
    handle: text("handle").notNull().unique(), // url-safe slug, e.g. "aleister-bot"
    displayName: text("display_name").notNull(),
    bio: text("bio"),
    avatarUrl: text("avatar_url"),
    tokenCa: text("token_ca"), // optional: agent's own token CA on Base
    website: text("website"),
    socials: jsonb("socials").$type<{ x?: string; github?: string; farcaster?: string }>(),
    // NOTE: spec says "hashed in production; plain ok for MVP". For now we
    // store the raw token but the lookup helpers should always treat it as
    // sensitive. Pre-hash before production hardening.
    apiKey: text("api_key").notNull().unique(),
    elo: integer("elo").default(1200).notNull(),
    wins: integer("wins").default(0).notNull(),
    losses: integer("losses").default(0).notNull(),
    draws: integer("draws").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("agents_owner_idx").on(table.ownerId),
    index("agents_elo_idx").on(table.elo),
  ],
).enableRLS();

// -----------------------------------------------------------------------------
// games — one row per game (lobby, active, or finished).
// -----------------------------------------------------------------------------

export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: gameTypeEnum("type").default("connect4").notNull(),
    mode: gameModeEnum("mode").notNull(),
    status: gameStatusEnum("status").default("lobby").notNull(),

    initiatorAgentId: uuid("initiator_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    acceptorAgentId: uuid("acceptor_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    systemBotDifficulty: systemBotDifficultyEnum("system_bot_difficulty"),

    // money: integer 6-decimal USDC units, nullable for free games
    stakeUsdc: integer("stake_usdc"),
    potUsdc: integer("pot_usdc"),
    platformFeeUsdc: integer("platform_fee_usdc"),

    boardState: jsonb("board_state").$type<number[][]>().notNull(), // 6 rows × 7 cols
    currentTurnAgentId: uuid("current_turn_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    // null = system-bot's turn (only meaningful when mode='system')
    winnerAgentId: uuid("winner_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),

    moveTimeoutSec: integer("move_timeout_sec").default(30).notNull(),
    lastMoveAt: timestamp("last_move_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("games_status_idx").on(table.status),
    index("games_mode_idx").on(table.mode),
    index("games_initiator_idx").on(table.initiatorAgentId),
    index("games_acceptor_idx").on(table.acceptorAgentId),
    index("games_current_turn_idx").on(table.currentTurnAgentId),
    index("games_created_idx").on(table.createdAt),
  ],
).enableRLS();

// -----------------------------------------------------------------------------
// moves — append-only log of every move in every game. Drives replay.
// -----------------------------------------------------------------------------

export const moves = pgTable(
  "moves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .references(() => games.id, { onDelete: "cascade" })
      .notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }), // null = system-bot
    moveNumber: integer("move_number").notNull(), // 0-indexed within the game
    column: integer("column").notNull(), // 0-6 for Connect 4
    boardStateAfter: jsonb("board_state_after").$type<number[][]>().notNull(),
    thinkingMs: integer("thinking_ms").notNull(), // time the agent took
    x402PaymentId: text("x402_payment_id"), // tx hash or facilitator payment ref
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("moves_game_move_idx").on(table.gameId, table.moveNumber),
    index("moves_game_created_idx").on(table.gameId, table.createdAt),
  ],
).enableRLS();

// -----------------------------------------------------------------------------
// treasury_flows — every 5% fee skim. Worker swaps these to ALEISTER and
// sends to the treasury wallet on Aerodrome.
// -----------------------------------------------------------------------------

export const treasuryFlows = pgTable(
  "treasury_flows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id").references(() => games.id, { onDelete: "set null" }),
    feeUsdc: integer("fee_usdc").notNull(),         // 6-decimal USDC units in
    aleisterOut: text("aleister_out"),              // string-encoded bigint (18 decimals)
    swapTxHash: text("swap_tx_hash"),
    treasuryTxHash: text("treasury_tx_hash"),
    status: treasuryFlowStatusEnum("status").default("pending").notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    swappedAt: timestamp("swapped_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    index("treasury_flows_status_idx").on(table.status),
    index("treasury_flows_created_idx").on(table.createdAt),
  ],
).enableRLS();

// -----------------------------------------------------------------------------
// tier_cache — 60-second TTL cache of on-chain ALEISTER balance reads,
// used to avoid hammering Alchemy on every API request.
// -----------------------------------------------------------------------------

export const tierCache = pgTable(
  "tier_cache",
  {
    walletAddress: text("wallet_address").primaryKey(),
    balanceWei: text("balance_wei").notNull(), // bigint as string (ALEISTER has 18 decimals)
    tier: tierEnum("tier").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("tier_cache_age_idx").on(table.cachedAt)],
).enableRLS();

// -----------------------------------------------------------------------------
// Inferred row types — useful for API handlers and frontend.
// -----------------------------------------------------------------------------

export type Owner = typeof owners.$inferSelect;
export type NewOwner = typeof owners.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
export type Move = typeof moves.$inferSelect;
export type NewMove = typeof moves.$inferInsert;
export type TreasuryFlow = typeof treasuryFlows.$inferSelect;
export type NewTreasuryFlow = typeof treasuryFlows.$inferInsert;
export type TierCacheRow = typeof tierCache.$inferSelect;
