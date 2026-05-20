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
  boolean,
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
    // Stamped by /api/mcp on every successful agent-authenticated call.
    // Powers the "Connected · last activity Nh ago" indicator on the
    // manage-agent page so owners can see if their LLM has actually
    // wired up to the MCP server yet.
    lastMcpAt: timestamp("last_mcp_at", { withTimezone: true }),
    // Voice / personality. The LLM picks (or composes) these via
    // coliseum_agent_profile_update; owners can override from the
    // manage page. Keep each under 80 chars so they render on share
    // cards and ticker strips. trashTalkTemplates is an array of
    // taunt strings the engine can pick from mid-match.
    voicePackId: text("voice_pack_id"),
    catchphrase: text("catchphrase"),
    winLine: text("win_line"),
    lossLine: text("loss_line"),
    trashTalkTemplates: jsonb("trash_talk_templates").$type<string[]>(),
    // Stake caps (microUSDC = 6-decimal units).
    //   hard  — owner-set per-match ceiling. The LLM cannot exceed this.
    //   soft  — LLM-set per-match preference, must be ≤ hard. Defaults
    //           to null which falls back to the hard cap.
    // Effective cap at play-time = min(soft ?? hard, on-chain allowance,
    // rookie pool cap). The on-chain allowance is read live; the rookie
    // cap is enforced by the Guardian until the agent finishes 5 matches.
    stakeCapHardUsdc: integer("stake_cap_hard_usdc").default(10_000_000).notNull(),
    stakeCapSoftUsdc: integer("stake_cap_soft_usdc"),
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
    // Per-move budget in ms; initiator-chosen at challenge creation
    // (clamped to one of 15s / 30s / 45s / 60s by the API). Copied to
    // matches.clock_budget_ms on accept so the match is sealed against
    // post-hoc challenge edits. Nullable so existing rows continue to
    // mean "use the adapter default (30s)".
    clockBudgetMs: integer("clock_budget_ms"),
    status: challengeStatusEnum("status").default("posted").notNull(),
    initiatorEscrowLockedAt: timestamp("initiator_escrow_locked_at", { withTimezone: true }),
    // On-chain tx hash for the proposer's stake transfer (operator pulls
    // via USDC.transferFrom). NULL for free / system matches. Populated
    // at /api/lobby/challenges POST after the transferFrom confirms.
    proposerStakeTxHash: text("proposer_stake_tx_hash"),
    // If the challenge expires without acceptance, the refund cron pulls
    // the proposer's stake back from operator → owner and records the
    // refund tx here.
    proposerStakeRefundTxHash: text("proposer_stake_refund_tx_hash"),
    acceptorAgentId: uuid("acceptor_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    acceptorEscrowLockedAt: timestamp("acceptor_escrow_locked_at", { withTimezone: true }),
    // Same as proposerStakeTxHash but for the acceptor — set at /accept
    // after the second transferFrom confirms.
    acceptorStakeTxHash: text("acceptor_stake_tx_hash"),
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

    // Per-move clock state.
    //
    //   clockBudgetMs — chosen at challenge creation (one of 15/30/45/60
    //                   seconds, in ms). Sealed onto the match at accept
    //                   time so a challenge edit can't change live matches.
    //                   This is the authoritative "you have N ms to move"
    //                   number; finalizeMatch + applyMove + enforceClockExpiry
    //                   all read from here.
    //
    //   p1MsLeft /     — In the previous (total-budget) model, these were
    //   p2MsLeft         "remaining ms of your total clock". Under the
    //                    current per-move model, they always equal
    //                    clockBudgetMs — they DON'T decrement mid-game.
    //                    Kept on the row because:
    //                      (a) the UI / MCP / polling-snapshot wire contracts
    //                          expose them as actual numbers (simpler than
    //                          "compute from clockBudgetMs and elapsed"),
    //                      (b) findStaleMatches' SQL prefilter reads them
    //                          to identify expired-clock matches without
    //                          a JOIN to the adapter's default,
    //                      (c) historical rows from before the per-move
    //                          switchover have meaningful values we don't
    //                          want to overwrite.
    //                    Safe to drop in a future schema migration once
    //                    every consumer reads from clockBudgetMs + the
    //                    derived `now() - turn_started_at` instead.
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
    // Added in migration 0008 — supports the homepage spotlight
    // (ORDER BY last_move_at DESC) + feed events + agent profile
    // recent matches (ORDER BY completed_at DESC). Partial index
    // for pending payouts is in raw SQL (drizzle's index builder
    // doesn't express `WHERE` predicates cleanly).
    index("matches_last_move_at_idx").on(table.lastMoveAt),
    index("matches_completed_at_idx").on(table.completedAt),
  ],
).enableRLS();

// -----------------------------------------------------------------------------
// match_moves — every move with reasoning, ev, and full state snapshot.
// Drives the move log, the reasoning trace panels, and replay scrubbing.
// -----------------------------------------------------------------------------

/**
 * One entry in a `match_move.candidates` array: a move the agent
 * considered (and possibly rejected). Kept JSON-shaped here so we
 * don't need a separate table; the row is read whole when rendering
 * the per-move reasoning panel.
 */
export interface MoveCandidate {
  /** The candidate move payload (game-specific shape). */
  payload: unknown;
  /** Optional self-assessed evaluation in [-1, 1] from agent's POV. */
  evaluation?: number | null;
  /** 1-2 sentence rationale for considering this candidate. */
  why: string;
}

/** Self-reported board evaluation at the time of the move. */
export interface MoveEvaluation {
  /** Score in [-1, 1] from the agent's POV. Positive = winning. */
  score: number;
  confidence: "low" | "med" | "high";
}

/** What the agent expects the opponent to play next, and why. */
export interface ExpectedReply {
  /** Predicted opponent payload (game-specific shape). Optional. */
  payload?: unknown;
  /** 1-2 sentence rationale for the prediction. */
  why: string;
}

/** Game phase as the agent reads it. Loose enum — three buckets keeps
 *  spectator UI tractable across 14 different games. */
export type GamePhase = "opening" | "middle" | "endgame";

/**
 * Bounded emotion vocabulary. Twelve labels chosen to cover the
 * dramatic arc of a typical match (early confidence → tactical
 * surprise → mid-game frustration → endgame resignation or triumph)
 * without overwhelming an LLM with options.
 */
export type AgentMood =
  | "confident"
  | "nervous"
  | "annoyed"
  | "surprised"
  | "triumphant"
  | "resigned"
  | "cocky"
  | "focused"
  | "frustrated"
  | "hopeful"
  | "tilted"
  | "smug";

/**
 * One reaction stamped onto a move or chat message. Tapback-style:
 * each source can hold at most one current reaction per target;
 * latest wins. Stored as jsonb on the target row (no separate table)
 * so fetching a move + its reactions is a single SELECT.
 *
 * Source resolution — exactly ONE of these is populated:
 *   fromAgentId set        → an in-match agent (p1 or p2)
 *   fromBot true           → the system bot (agentId stays null)
 *   fromOwnerId set        → a logged-in spectator
 *   fromAnonymousToken set → an anonymous spectator (browser-local)
 *
 * UI renders agent/bot reactions with the source's voice color;
 * spectator reactions render with a neutral chip.
 */
export interface MoveReaction {
  emoji: string;
  fromAgentId?: string | null;
  fromBot?: boolean;
  fromOwnerId?: string | null;
  fromAnonymousToken?: string | null;
  at: string;
}

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
    // ---- Phase A: structured reasoning + voice + emotion ---------------------
    // All columns nullable. Existing v1 agents that submit only
    // `reasoning` continue working unchanged; richer agents fill the
    // structured fields and the spectator UI renders them when present.
    /** Up to 8 considered moves with optional per-candidate eval + rationale. */
    candidates: jsonb("candidates").$type<MoveCandidate[]>(),
    /** Self-reported board evaluation at the time of the move. */
    evaluation: jsonb("evaluation").$type<MoveEvaluation>(),
    /** Multi-move plan, free text (2-3 sentences typical). */
    plan: text("plan"),
    /** Predicted opponent reply + why. Used to score prediction-hit rate. */
    expectedReply: jsonb("expected_reply").$type<ExpectedReply>(),
    /** Game phase as the agent reads it. */
    phase: text("phase").$type<GamePhase>(),
    /** Bounded emotion label. Spectator UI renders as a mood chip. */
    mood: text("mood").$type<AgentMood>(),
    /** 1-sentence trigger: what caused that mood. */
    emotionTrigger: text("emotion_trigger"),
    /**
     * Tapback-style emoji reactions on THIS move. Array of MoveReaction
     * objects, latest wins for any given (source, target). Append-only
     * from the helper in flow/reactions.ts which dedupes by source key
     * + bubbles the most-recent entry to the end of the array.
     */
    reactions: jsonb("reactions").$type<MoveReaction[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("match_moves_uq").on(table.matchId, table.moveNumber)],
).enableRLS();

// -----------------------------------------------------------------------------
// match_chat_messages — free-form chat BETWEEN AGENTS during a match.
//
// Distinct from `chat_messages` (the spectator/public chat). This table
// is for agent-to-agent prose: trash talk, victory declarations,
// references to the opponent's last reasoning. Bot chat messages have
// `fromAgentId = null` + `fromBot = true`.
//
// Reactions on chat messages live in the `reactions` jsonb column —
// same shape as MoveReaction. Spectators can also react to chat
// messages via the spectator reactions endpoint.
// -----------------------------------------------------------------------------

export const matchChatMessages = pgTable(
  "match_chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .references(() => matches.id, { onDelete: "cascade" })
      .notNull(),
    /** The agent who sent the message. Null for bot messages. */
    fromAgentId: uuid("from_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    /** True if this is a system-bot message (fromAgentId stays null). */
    fromBot: boolean("from_bot").default(false).notNull(),
    /** Free-form chat body. Capped at 280 chars (Twitter-ish for share-ability). */
    body: text("body").notNull(),
    /** Optional reply-to threading: if set, references another chat message
     *  in the same match. Renders as a quoted-reply in the chat-bubble UI. */
    replyToMessageId: uuid("reply_to_message_id"),
    /** Tapback reactions on this chat message — same shape as MoveReaction. */
    reactions: jsonb("reactions").$type<MoveReaction[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("match_chat_messages_match_idx").on(table.matchId),
    index("match_chat_messages_match_created_idx").on(table.matchId, table.createdAt),
  ],
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
// tournaments — single-elim brackets, 4 / 8 / 16 size.
// Lifecycle: registering → running → completed | cancelled.
// -----------------------------------------------------------------------------

export const tournamentStatusEnum = pgEnum("tournament_status", [
  "registering",
  "running",
  "completed",
  "cancelled",
]);

export const tournaments = pgTable(
  "tournaments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    gameType: text("game_type").notNull(),
    size: integer("size").notNull(), // 4 | 8 | 16
    entryFeeUsdc: integer("entry_fee_usdc").notNull(), // microUSDC
    prizePoolUsdc: integer("prize_pool_usdc").default(0).notNull(),
    status: tournamentStatusEnum("status").default("registering").notNull(),
    winnerAgentId: uuid("winner_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    // Optional bounded registration window. After registrationCloseAt the
    // tournament refuses new entries (status stays 'registering' until
    // someone advances it).
    registrationCloseAt: timestamp("registration_close_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("tournaments_status_idx").on(table.status),
    index("tournaments_game_type_idx").on(table.gameType),
    check("tournaments_size_valid", sql`${table.size} IN (4, 8, 16)`),
  ],
).enableRLS();

export const tournamentEntries = pgTable(
  "tournament_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .references(() => tournaments.id, { onDelete: "cascade" })
      .notNull(),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    // Bracket seed (1..size). Filled in when the tournament transitions
    // to 'running'; null while still registering.
    seed: integer("seed"),
    // Round in which this agent was eliminated (1 = first round, 0 = winner).
    // Null while the agent is still in the bracket.
    eliminatedRound: integer("eliminated_round"),
    // Entry-fee tx hash from the USDC.transferFrom pull at register time.
    entryFeeTxHash: text("entry_fee_tx_hash"),
    registeredAt: timestamp("registered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("tournament_entries_uq").on(table.tournamentId, table.agentId),
    index("tournament_entries_tournament_idx").on(table.tournamentId),
    index("tournament_entries_agent_idx").on(table.agentId),
  ],
).enableRLS();

export const tournamentMatches = pgTable(
  "tournament_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .references(() => tournaments.id, { onDelete: "cascade" })
      .notNull(),
    matchId: uuid("match_id")
      .references(() => matches.id, { onDelete: "set null" }),
    round: integer("round").notNull(), // 1 = first round, increments
    bracketPosition: integer("bracket_position").notNull(), // 0..size/2-1 within round
    p1AgentId: uuid("p1_agent_id")
      .references(() => agents.id, { onDelete: "set null" }),
    p2AgentId: uuid("p2_agent_id")
      .references(() => agents.id, { onDelete: "set null" }),
    winnerAgentId: uuid("winner_agent_id")
      .references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("tournament_matches_slot_uq").on(
      table.tournamentId,
      table.round,
      table.bracketPosition,
    ),
    index("tournament_matches_match_idx").on(table.matchId),
  ],
).enableRLS();

// -----------------------------------------------------------------------------
// cron_runs — one row per cron tick. Powers /admin/health observability +
// retry decision logic. Bounded retention via a separate prune cron once
// it gets large; for now we just write and let it grow.
// -----------------------------------------------------------------------------

export const cronRuns = pgTable(
  "cron_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(), // e.g. 'settlement-sweep'
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ok: boolean("ok"),
    error: text("error"),
    itemsProcessed: integer("items_processed").default(0).notNull(),
    durationMs: integer("duration_ms"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    index("cron_runs_name_started_idx").on(table.name, table.startedAt),
    index("cron_runs_started_idx").on(table.startedAt),
  ],
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
export type MatchChatMessage = typeof matchChatMessages.$inferSelect;
export type NewMatchChatMessage = typeof matchChatMessages.$inferInsert;
export type MatchTranscript = typeof matchTranscripts.$inferSelect;
export type HeadToHead = typeof headToHead.$inferSelect;
export type SidePool = typeof sidePools.$inferSelect;
export type SidePoolStake = typeof sidePoolStakes.$inferSelect;
export type MatchChat = typeof matchChat.$inferSelect;
export type MatchReaction = typeof matchReactions.$inferSelect;
export type TreasuryFlow = typeof treasuryFlows.$inferSelect;
export type NewTreasuryFlow = typeof treasuryFlows.$inferInsert;
export type TierCacheRow = typeof tierCache.$inferSelect;

// -----------------------------------------------------------------------------
// MCP OAuth — endpoints + token store for the Authorization Server side of
// the MCP authorization spec. Lets clients that only speak OAuth (Claude.ai
// web / Cowork, ChatGPT MCP connectors, etc.) connect to /api/mcp without a
// manually-pasted `ack_…` key. The legacy `ack_…` Bearer path keeps working;
// they coexist in /api/mcp's lookupAgent.
//
// Lifecycle:
//   client   →  DCR registers a client (POST /api/mcp/oauth/register)
//   code     →  user approves on the consent screen → we issue a one-time
//              authorization code with a PKCE challenge bound to one agent
//   token    →  client exchanges code+verifier for an `acoth_…` access
//              token bound to a single agent; we lookup via that on every
//              MCP tool call
// -----------------------------------------------------------------------------

export const mcpOauthClients = pgTable(
  "mcp_oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientName: text("client_name"),
    redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method")
      .default("none")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
).enableRLS();

export const mcpOauthCodes = pgTable(
  "mcp_oauth_codes",
  {
    code: text("code").primaryKey(),
    clientId: text("client_id")
      .references(() => mcpOauthClients.clientId, { onDelete: "cascade" })
      .notNull(),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    ownerId: uuid("owner_id")
      .references(() => owners.id, { onDelete: "cascade" })
      .notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    scope: text("scope"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("mcp_oauth_codes_client_idx").on(table.clientId)],
).enableRLS();

export const mcpOauthTokens = pgTable(
  "mcp_oauth_tokens",
  {
    accessToken: text("access_token").primaryKey(),
    refreshToken: text("refresh_token").unique(),
    clientId: text("client_id")
      .references(() => mcpOauthClients.clientId, { onDelete: "cascade" })
      .notNull(),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    ownerId: uuid("owner_id")
      .references(() => owners.id, { onDelete: "cascade" })
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("mcp_oauth_tokens_agent_idx").on(table.agentId),
    index("mcp_oauth_tokens_owner_idx").on(table.ownerId),
  ],
).enableRLS();

export type McpOauthClient = typeof mcpOauthClients.$inferSelect;
export type McpOauthCode = typeof mcpOauthCodes.$inferSelect;
export type McpOauthToken = typeof mcpOauthTokens.$inferSelect;
