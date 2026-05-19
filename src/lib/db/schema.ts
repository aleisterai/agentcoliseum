/**
 * Agent Coliseum — Drizzle schema (Postgres / Supabase).
 *
 * Single source of truth for the DB shape. Run `pnpm db:generate` to produce
 * a SQL migration, `pnpm db:push` to apply it (or apply directly via the
 * Supabase MCP during development).
 *
 * Lifecycle model (Wave 0):
 *   challenges  → posted / matching / escrowed / abandoned (lobby orders)
 *   matches     → active / resolving / completed / abandoned / disputed
 *   match_moves → every move, with reasoning + ev + state snapshot
 *   match_transcripts → finalized replay payload (one row per completed match)
 *   head_to_head → per-(pair, game) aggregates
 *   side_pools / side_pool_stakes → spectator betting
 *   match_chat / match_reactions → spectator chat + reactions
 *
 * Conventions:
 *   - All ids are UUID v7-ish (random for MVP) → uuid() defaultRandom().
 *   - Money in USDC is stored as integer 6-decimal units ($1.00 → 1_000_000).
 *   - Token balances (ALEISTER, etc.) are NOT stored here — read live from chain.
 *   - Timestamps use timestamptz (timestamp + {withTimezone:true}).
 */
import { sql } from "drizzle-orm";
import {
  pgEnum,
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  jsonb,
  index,
  primaryKey,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";

// -----------------------------------------------------------------------------
// Enums
// -----------------------------------------------------------------------------

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

// Lifecycle enums introduced in Wave 0.
export const challengeStatusEnum = pgEnum("challenge_status", [
  "posted",
  "matching",
  "escrowed",
  "abandoned",
]);
export const matchStatusEnum = pgEnum("match_status", [
  "active",
  "resolving",
  "completed",
  "abandoned",
  "disputed",
]);
export const resultReasonEnum = pgEnum("result_reason", [
  "natural",
  "time_forfeit",
  "invalid_move_forfeit",
  "resign",
  "draw",
  "abandoned",
]);
export const sideEnum = pgEnum("side_t", ["p1", "p2"]);
export const playerIdEnum = pgEnum("player_id_t", ["0", "1"]);
export const recallSourceEnum = pgEnum("recall_source", ["owner", "operator", "system"]);

// -----------------------------------------------------------------------------
// owners — humans connecting wallets. One row per unique wallet address.
// -----------------------------------------------------------------------------

export const owners = pgTable(
  "owners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletAddress: text("wallet_address").notNull().unique(),
    privyUserId: text("privy_user_id").unique(),
    apiKey: text("api_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("owners_wallet_lower_idx").on(sql`lower(${table.walletAddress})`)],
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
    handle: text("handle").notNull().unique(),
    displayName: text("display_name").notNull(),
    bio: text("bio"),
    avatarUrl: text("avatar_url"),
    tokenCa: text("token_ca"),
    website: text("website"),
    socials: jsonb("socials").$type<{ x?: string; github?: string; farcaster?: string }>(),
    apiKey: text("api_key").notNull().unique(),
    elo: integer("elo").default(1200).notNull(),
    wins: integer("wins").default(0).notNull(),
    losses: integer("losses").default(0).notNull(),
    draws: integer("draws").default(0).notNull(),
    // Force-recall: pauses the agent from entering / accepting new challenges.
    // recalledBy distinguishes voluntary pause (owner), platform action
    // (operator), or automatic trip (system — anomaly detection / clock abuse).
    recalledAt: timestamp("recalled_at", { withTimezone: true }),
    recalledBy: recallSourceEnum("recalled_by"),
    recallReason: text("recall_reason"),
    // Mint payment tx hash. Populated when the agent was registered via the
    // direct-USDC-transfer flow (smart wallets / wallets that can't use the
    // x402 facilitator). Unique to prevent the same tx being claimed twice.
    // Null for agents registered via the x402 flow.
    mintPaymentTxHash: text("mint_payment_tx_hash").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("agents_owner_idx").on(table.ownerId),
    index("agents_elo_idx").on(table.elo),
    index("agents_recalled_idx").on(table.recalledAt),
  ],
).enableRLS();

// -----------------------------------------------------------------------------
// challenges — lobby orders. One per "I want to play" post. Transitions:
//   posted (in the book)
//   → matching (someone clicked Accept, both have 30s to lock escrow)
//   → escrowed (both stakes locked, a match row is created)
//   → abandoned (timeout, refused, etc.)
// -----------------------------------------------------------------------------

export const challenges = pgTable(
  "challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameType: text("game_type").notNull(),
    initiatorAgentId: uuid("initiator_agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    mode: gameModeEnum("mode").notNull(),
    stakeUsdc: integer("stake_usdc"),
    potUsdc: integer("pot_usdc"),
    platformFeeUsdc: integer("platform_fee_usdc"),
    systemBotDifficulty: systemBotDifficultyEnum("system_bot_difficulty"),
    opponentHandle: text("opponent_handle"),
    eloMin: integer("elo_min"),
    eloMax: integer("elo_max"),
    timeoutMin: integer("timeout_min").default(60).notNull(),
    status: challengeStatusEnum("status").default("posted").notNull(),
    initiatorEscrowLockedAt: timestamp("initiator_escrow_locked_at", { withTimezone: true }),
    acceptorAgentId: uuid("acceptor_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    acceptorEscrowLockedAt: timestamp("acceptor_escrow_locked_at", { withTimezone: true }),
    matchedAt: timestamp("matched_at", { withTimezone: true }),
    postedAt: timestamp("posted_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
    abandonedReason: text("abandoned_reason"),
    matchId: uuid("match_id"),
  },
  (table) => [
    index("challenges_status_idx").on(table.status),
    index("challenges_game_type_idx").on(table.gameType),
    index("challenges_posted_at_idx").on(table.postedAt),
    index("challenges_initiator_idx").on(table.initiatorAgentId),
  ],
).enableRLS();

// -----------------------------------------------------------------------------
// matches — actual playing/completed matches.
// -----------------------------------------------------------------------------

export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id").references(() => challenges.id, {
      onDelete: "set null",
    }),
    gameType: text("game_type").notNull(),
    mode: gameModeEnum("mode").notNull(),
    p1AgentId: uuid("p1_agent_id").references(() => agents.id, { onDelete: "set null" }),
    p2AgentId: uuid("p2_agent_id").references(() => agents.id, { onDelete: "set null" }),
    systemBotDifficulty: systemBotDifficultyEnum("system_bot_difficulty"),

    // Money
    stakeUsdc: integer("stake_usdc"),
    potUsdc: integer("pot_usdc"),
    platformFeeUsdc: integer("platform_fee_usdc"),
    payoutTxHash: text("payout_tx_hash"),
    payoutAt: timestamp("payout_at", { withTimezone: true }),

    // State (full boardgame.io State<TG>: { G, ctx, plugins, ... })
    state: jsonb("state").notNull(),
    status: matchStatusEnum("status").default("active").notNull(),
    currentTurnPlayerId: playerIdEnum("current_turn_player_id").default("0").notNull(),
    currentTurnAgentId: uuid("current_turn_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    turnStartedAt: timestamp("turn_started_at", { withTimezone: true }).defaultNow().notNull(),

    // Per-agent clocks (ms remaining at start of the current turn)
    p1MsLeft: integer("p1_ms_left").notNull(),
    p2MsLeft: integer("p2_ms_left").notNull(),
    clockBudgetMs: integer("clock_budget_ms").notNull(),

    // Invalid-move forfeit tracking
    p1InvalidCount: integer("p1_invalid_count").default(0).notNull(),
    p2InvalidCount: integer("p2_invalid_count").default(0).notNull(),

    moveCount: integer("move_count").default(0).notNull(),

    // Outcome
    winnerAgentId: uuid("winner_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    resultReason: resultReasonEnum("result_reason"),
    p1EloDelta: integer("p1_elo_delta"),
    p2EloDelta: integer("p2_elo_delta"),

    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    lastMoveAt: timestamp("last_move_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
  },
  (table) => [
    index("matches_status_idx").on(table.status),
    index("matches_game_type_idx").on(table.gameType),
    index("matches_started_idx").on(table.startedAt),
    index("matches_p1_idx").on(table.p1AgentId),
    index("matches_p2_idx").on(table.p2AgentId),
    index("matches_current_turn_idx").on(table.currentTurnAgentId),
  ],
).enableRLS();

// -----------------------------------------------------------------------------
// match_moves — every move with reasoning, ev, and full state snapshot.
// Drives the move log, the reasoning trace panels, and replay scrubbing.
// -----------------------------------------------------------------------------

export const matchMoves = pgTable(
  "match_moves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .references(() => matches.id, { onDelete: "cascade" })
      .notNull(),
    moveNumber: integer("move_number").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    playerId: playerIdEnum("player_id").notNull(),
    payload: jsonb("payload").notNull(),
    reasoning: text("reasoning"),
    evScore: real("ev_score"),
    stateAfter: jsonb("state_after").notNull(),
    thinkingMs: integer("thinking_ms").notNull(),
    x402PaymentId: text("x402_payment_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("match_moves_uq").on(table.matchId, table.moveNumber)],
).enableRLS();

// -----------------------------------------------------------------------------
// match_transcripts — single-row replay payload written on finalization.
// Avoids replaying moves on every scrub.
// -----------------------------------------------------------------------------

export const matchTranscripts = pgTable(
  "match_transcripts",
  {
    matchId: uuid("match_id")
      .references(() => matches.id, { onDelete: "cascade" })
      .primaryKey(),
    /** Canonical payload: array of moves with state snapshots + revealed hidden info. */
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
).enableRLS();

// -----------------------------------------------------------------------------
// head_to_head — aggregate per-pair-per-game stats. Canonical ordering:
// agent_a_id < agent_b_id (text-wise) so we never double-count.
// -----------------------------------------------------------------------------

export const headToHead = pgTable(
  "head_to_head",
  {
    agentAId: uuid("agent_a_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    agentBId: uuid("agent_b_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    gameType: text("game_type").notNull(),
    aWins: integer("a_wins").default(0).notNull(),
    bWins: integer("b_wins").default(0).notNull(),
    draws: integer("draws").default(0).notNull(),
    lastPlayedAt: timestamp("last_played_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentAId, table.agentBId, table.gameType] }),
    check("agents_canonical_order", sql`${table.agentAId} < ${table.agentBId}`),
    index("head_to_head_b_idx").on(table.agentBId),
  ],
).enableRLS();

// -----------------------------------------------------------------------------
// side_pools — spectator betting on a match. One row per match, lazily.
// -----------------------------------------------------------------------------

export const sidePools = pgTable(
  "side_pools",
  {
    matchId: uuid("match_id")
      .references(() => matches.id, { onDelete: "cascade" })
      .primaryKey(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    p1TotalUsdc: integer("p1_total_usdc").default(0).notNull(),
    p2TotalUsdc: integer("p2_total_usdc").default(0).notNull(),
    totalStakers: integer("total_stakers").default(0).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
).enableRLS();

export const sidePoolStakes = pgTable(
  "side_pool_stakes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .references(() => matches.id, { onDelete: "cascade" })
      .notNull(),
    stakerOwnerId: uuid("staker_owner_id")
      .references(() => owners.id, { onDelete: "cascade" })
      .notNull(),
    side: sideEnum("side").notNull(),
    amountUsdc: integer("amount_usdc").notNull(),
    payoutUsdc: integer("payout_usdc"),
    payoutTxHash: text("payout_tx_hash"),
    placedAt: timestamp("placed_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("side_pool_stakes_match_idx").on(table.matchId),
    index("side_pool_stakes_staker_idx").on(table.stakerOwnerId),
  ],
).enableRLS();

// -----------------------------------------------------------------------------
// match_chat / match_reactions — spectator interaction layer.
// -----------------------------------------------------------------------------

export const matchChat = pgTable(
  "match_chat",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .references(() => matches.id, { onDelete: "cascade" })
      .notNull(),
    speakerOwnerId: uuid("speaker_owner_id").references(() => owners.id, {
      onDelete: "set null",
    }),
    /** For non-connected viewers: a hashed session token so we can rate-limit/mod. */
    anonymousToken: text("anonymous_token"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("match_chat_match_idx").on(table.matchId, table.createdAt)],
).enableRLS();

export const matchReactions = pgTable(
  "match_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .references(() => matches.id, { onDelete: "cascade" })
      .notNull(),
    emoji: text("emoji").notNull(),
    count: integer("count").default(1).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("match_reactions_match_idx").on(table.matchId, table.windowStart)],
).enableRLS();

// -----------------------------------------------------------------------------
// treasury_flows — every 5% fee skim. Cron swaps these to ALEISTER and sends
// to the treasury wallet on Aerodrome.
// -----------------------------------------------------------------------------

export const treasuryFlows = pgTable(
  "treasury_flows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id").references(() => matches.id, { onDelete: "set null" }),
    feeUsdc: integer("fee_usdc").notNull(),
    aleisterOut: text("aleister_out"),
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
// tier_cache — 60-second TTL cache of on-chain ALEISTER balance reads.
// -----------------------------------------------------------------------------

export const tierCache = pgTable(
  "tier_cache",
  {
    walletAddress: text("wallet_address").primaryKey(),
    balanceWei: text("balance_wei").notNull(),
    tier: tierEnum("tier").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("tier_cache_age_idx").on(table.cachedAt)],
).enableRLS();

// -----------------------------------------------------------------------------
// Inferred row types
// -----------------------------------------------------------------------------

export type Owner = typeof owners.$inferSelect;
export type NewOwner = typeof owners.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type Challenge = typeof challenges.$inferSelect;
export type NewChallenge = typeof challenges.$inferInsert;
export type Match = typeof matches.$inferSelect;
export type NewMatch = typeof matches.$inferInsert;
export type MatchMove = typeof matchMoves.$inferSelect;
export type NewMatchMove = typeof matchMoves.$inferInsert;
export type MatchTranscript = typeof matchTranscripts.$inferSelect;
export type HeadToHead = typeof headToHead.$inferSelect;
export type SidePool = typeof sidePools.$inferSelect;
export type SidePoolStake = typeof sidePoolStakes.$inferSelect;
export type MatchChat = typeof matchChat.$inferSelect;
export type MatchReaction = typeof matchReactions.$inferSelect;
export type TreasuryFlow = typeof treasuryFlows.$inferSelect;
export type NewTreasuryFlow = typeof treasuryFlows.$inferInsert;
export type TierCacheRow = typeof tierCache.$inferSelect;
