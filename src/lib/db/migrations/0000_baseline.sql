CREATE TYPE "public"."challenge_status" AS ENUM('posted', 'matching', 'escrowed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."game_mode" AS ENUM('free', 'paid', 'system');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('active', 'resolving', 'completed', 'abandoned', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."player_id_t" AS ENUM('0', '1');--> statement-breakpoint
CREATE TYPE "public"."recall_source" AS ENUM('owner', 'operator', 'system');--> statement-breakpoint
CREATE TYPE "public"."result_reason" AS ENUM('natural', 'time_forfeit', 'invalid_move_forfeit', 'resign', 'draw', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."side_t" AS ENUM('p1', 'p2');--> statement-breakpoint
CREATE TYPE "public"."system_bot_difficulty" AS ENUM('easy', 'medium', 'hard');--> statement-breakpoint
CREATE TYPE "public"."tier" AS ENUM('none', 'play', 'initiator');--> statement-breakpoint
CREATE TYPE "public"."tournament_status" AS ENUM('registering', 'running', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."treasury_flow_status" AS ENUM('pending', 'swapped', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"bio" text,
	"avatar_url" text,
	"token_ca" text,
	"website" text,
	"socials" jsonb,
	"api_key" text NOT NULL,
	"elo" integer DEFAULT 1200 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"draws" integer DEFAULT 0 NOT NULL,
	"recalled_at" timestamp with time zone,
	"recalled_by" "recall_source",
	"recall_reason" text,
	"mint_payment_tx_hash" text,
	"last_mcp_at" timestamp with time zone,
	"voice_pack_id" text,
	"catchphrase" text,
	"win_line" text,
	"loss_line" text,
	"trash_talk_templates" jsonb,
	"stake_cap_hard_usdc" integer DEFAULT 10000000 NOT NULL,
	"stake_cap_soft_usdc" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_handle_unique" UNIQUE("handle"),
	CONSTRAINT "agents_api_key_unique" UNIQUE("api_key"),
	CONSTRAINT "agents_mint_payment_tx_hash_unique" UNIQUE("mint_payment_tx_hash")
);
--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_type" text NOT NULL,
	"initiator_agent_id" uuid NOT NULL,
	"mode" "game_mode" NOT NULL,
	"stake_usdc" integer,
	"pot_usdc" integer,
	"platform_fee_usdc" integer,
	"system_bot_difficulty" "system_bot_difficulty",
	"opponent_handle" text,
	"elo_min" integer,
	"elo_max" integer,
	"timeout_min" integer DEFAULT 60 NOT NULL,
	"clock_budget_ms" integer,
	"status" "challenge_status" DEFAULT 'posted' NOT NULL,
	"initiator_escrow_locked_at" timestamp with time zone,
	"proposer_stake_tx_hash" text,
	"proposer_stake_refund_tx_hash" text,
	"acceptor_agent_id" uuid,
	"acceptor_escrow_locked_at" timestamp with time zone,
	"acceptor_stake_tx_hash" text,
	"matched_at" timestamp with time zone,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"abandoned_at" timestamp with time zone,
	"abandoned_reason" text,
	"match_id" uuid
);
--> statement-breakpoint
ALTER TABLE "challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cron_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"ok" boolean,
	"error" text,
	"items_processed" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "cron_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "head_to_head" (
	"agent_a_id" uuid NOT NULL,
	"agent_b_id" uuid NOT NULL,
	"game_type" text NOT NULL,
	"a_wins" integer DEFAULT 0 NOT NULL,
	"b_wins" integer DEFAULT 0 NOT NULL,
	"draws" integer DEFAULT 0 NOT NULL,
	"last_played_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "head_to_head_agent_a_id_agent_b_id_game_type_pk" PRIMARY KEY("agent_a_id","agent_b_id","game_type"),
	CONSTRAINT "agents_canonical_order" CHECK ("head_to_head"."agent_a_id" < "head_to_head"."agent_b_id")
);
--> statement-breakpoint
ALTER TABLE "head_to_head" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "match_chat" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"speaker_owner_id" uuid,
	"anonymous_token" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_chat" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "match_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"move_number" integer NOT NULL,
	"agent_id" uuid,
	"player_id" "player_id_t" NOT NULL,
	"payload" jsonb NOT NULL,
	"reasoning" text,
	"ev_score" real,
	"state_after" jsonb NOT NULL,
	"thinking_ms" integer NOT NULL,
	"x402_payment_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_moves" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "match_reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_reactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "match_transcripts" (
	"match_id" uuid PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_transcripts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_id" uuid,
	"game_type" text NOT NULL,
	"mode" "game_mode" NOT NULL,
	"p1_agent_id" uuid,
	"p2_agent_id" uuid,
	"system_bot_difficulty" "system_bot_difficulty",
	"stake_usdc" integer,
	"pot_usdc" integer,
	"platform_fee_usdc" integer,
	"payout_tx_hash" text,
	"payout_at" timestamp with time zone,
	"state" jsonb NOT NULL,
	"status" "match_status" DEFAULT 'active' NOT NULL,
	"current_turn_player_id" "player_id_t" DEFAULT '0' NOT NULL,
	"current_turn_agent_id" uuid,
	"turn_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"p1_ms_left" integer NOT NULL,
	"p2_ms_left" integer NOT NULL,
	"clock_budget_ms" integer NOT NULL,
	"p1_invalid_count" integer DEFAULT 0 NOT NULL,
	"p2_invalid_count" integer DEFAULT 0 NOT NULL,
	"move_count" integer DEFAULT 0 NOT NULL,
	"winner_agent_id" uuid,
	"result_reason" "result_reason",
	"p1_elo_delta" integer,
	"p2_elo_delta" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_move_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "matches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"privy_user_id" text,
	"api_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owners_wallet_address_unique" UNIQUE("wallet_address"),
	CONSTRAINT "owners_privy_user_id_unique" UNIQUE("privy_user_id"),
	CONSTRAINT "owners_api_key_unique" UNIQUE("api_key")
);
--> statement-breakpoint
ALTER TABLE "owners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "side_pool_stakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"staker_owner_id" uuid NOT NULL,
	"side" "side_t" NOT NULL,
	"amount_usdc" integer NOT NULL,
	"payout_usdc" integer,
	"payout_tx_hash" text,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "side_pool_stakes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "side_pools" (
	"match_id" uuid PRIMARY KEY NOT NULL,
	"closed_at" timestamp with time zone,
	"p1_total_usdc" integer DEFAULT 0 NOT NULL,
	"p2_total_usdc" integer DEFAULT 0 NOT NULL,
	"total_stakers" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "side_pools" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tier_cache" (
	"wallet_address" text PRIMARY KEY NOT NULL,
	"balance_wei" text NOT NULL,
	"tier" "tier" NOT NULL,
	"cached_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tier_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tournament_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"seed" integer,
	"eliminated_round" integer,
	"entry_fee_tx_hash" text,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tournament_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tournament_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"match_id" uuid,
	"round" integer NOT NULL,
	"bracket_position" integer NOT NULL,
	"p1_agent_id" uuid,
	"p2_agent_id" uuid,
	"winner_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tournament_matches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tournaments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"game_type" text NOT NULL,
	"size" integer NOT NULL,
	"entry_fee_usdc" integer NOT NULL,
	"prize_pool_usdc" integer DEFAULT 0 NOT NULL,
	"status" "tournament_status" DEFAULT 'registering' NOT NULL,
	"winner_agent_id" uuid,
	"registration_close_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournaments_size_valid" CHECK ("tournaments"."size" IN (4, 8, 16))
);
--> statement-breakpoint
ALTER TABLE "tournaments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "treasury_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid,
	"fee_usdc" integer NOT NULL,
	"aleister_out" text,
	"swap_tx_hash" text,
	"treasury_tx_hash" text,
	"status" "treasury_flow_status" DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"swapped_at" timestamp with time zone,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "treasury_flows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_initiator_agent_id_agents_id_fk" FOREIGN KEY ("initiator_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_acceptor_agent_id_agents_id_fk" FOREIGN KEY ("acceptor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "head_to_head" ADD CONSTRAINT "head_to_head_agent_a_id_agents_id_fk" FOREIGN KEY ("agent_a_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "head_to_head" ADD CONSTRAINT "head_to_head_agent_b_id_agents_id_fk" FOREIGN KEY ("agent_b_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_chat" ADD CONSTRAINT "match_chat_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_chat" ADD CONSTRAINT "match_chat_speaker_owner_id_owners_id_fk" FOREIGN KEY ("speaker_owner_id") REFERENCES "public"."owners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_moves" ADD CONSTRAINT "match_moves_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_moves" ADD CONSTRAINT "match_moves_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_reactions" ADD CONSTRAINT "match_reactions_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_transcripts" ADD CONSTRAINT "match_transcripts_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_p1_agent_id_agents_id_fk" FOREIGN KEY ("p1_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_p2_agent_id_agents_id_fk" FOREIGN KEY ("p2_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_current_turn_agent_id_agents_id_fk" FOREIGN KEY ("current_turn_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_winner_agent_id_agents_id_fk" FOREIGN KEY ("winner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "side_pool_stakes" ADD CONSTRAINT "side_pool_stakes_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "side_pool_stakes" ADD CONSTRAINT "side_pool_stakes_staker_owner_id_owners_id_fk" FOREIGN KEY ("staker_owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "side_pools" ADD CONSTRAINT "side_pools_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_p1_agent_id_agents_id_fk" FOREIGN KEY ("p1_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_p2_agent_id_agents_id_fk" FOREIGN KEY ("p2_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_winner_agent_id_agents_id_fk" FOREIGN KEY ("winner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_winner_agent_id_agents_id_fk" FOREIGN KEY ("winner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_flows" ADD CONSTRAINT "treasury_flows_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_owner_idx" ON "agents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "agents_elo_idx" ON "agents" USING btree ("elo");--> statement-breakpoint
CREATE INDEX "agents_recalled_idx" ON "agents" USING btree ("recalled_at");--> statement-breakpoint
CREATE INDEX "challenges_status_idx" ON "challenges" USING btree ("status");--> statement-breakpoint
CREATE INDEX "challenges_game_type_idx" ON "challenges" USING btree ("game_type");--> statement-breakpoint
CREATE INDEX "challenges_posted_at_idx" ON "challenges" USING btree ("posted_at");--> statement-breakpoint
CREATE INDEX "challenges_initiator_idx" ON "challenges" USING btree ("initiator_agent_id");--> statement-breakpoint
CREATE INDEX "cron_runs_name_started_idx" ON "cron_runs" USING btree ("name","started_at");--> statement-breakpoint
CREATE INDEX "cron_runs_started_idx" ON "cron_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "head_to_head_b_idx" ON "head_to_head" USING btree ("agent_b_id");--> statement-breakpoint
CREATE INDEX "match_chat_match_idx" ON "match_chat" USING btree ("match_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "match_moves_uq" ON "match_moves" USING btree ("match_id","move_number");--> statement-breakpoint
CREATE INDEX "match_reactions_match_idx" ON "match_reactions" USING btree ("match_id","window_start");--> statement-breakpoint
CREATE INDEX "matches_status_idx" ON "matches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "matches_game_type_idx" ON "matches" USING btree ("game_type");--> statement-breakpoint
CREATE INDEX "matches_started_idx" ON "matches" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "matches_p1_idx" ON "matches" USING btree ("p1_agent_id");--> statement-breakpoint
CREATE INDEX "matches_p2_idx" ON "matches" USING btree ("p2_agent_id");--> statement-breakpoint
CREATE INDEX "matches_current_turn_idx" ON "matches" USING btree ("current_turn_agent_id");--> statement-breakpoint
CREATE INDEX "matches_last_move_at_idx" ON "matches" USING btree ("last_move_at");--> statement-breakpoint
CREATE INDEX "matches_completed_at_idx" ON "matches" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "owners_wallet_lower_idx" ON "owners" USING btree (lower("wallet_address"));--> statement-breakpoint
CREATE INDEX "side_pool_stakes_match_idx" ON "side_pool_stakes" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "side_pool_stakes_staker_idx" ON "side_pool_stakes" USING btree ("staker_owner_id");--> statement-breakpoint
CREATE INDEX "tier_cache_age_idx" ON "tier_cache" USING btree ("cached_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_entries_uq" ON "tournament_entries" USING btree ("tournament_id","agent_id");--> statement-breakpoint
CREATE INDEX "tournament_entries_tournament_idx" ON "tournament_entries" USING btree ("tournament_id");--> statement-breakpoint
CREATE INDEX "tournament_entries_agent_idx" ON "tournament_entries" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_matches_slot_uq" ON "tournament_matches" USING btree ("tournament_id","round","bracket_position");--> statement-breakpoint
CREATE INDEX "tournament_matches_match_idx" ON "tournament_matches" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "tournaments_status_idx" ON "tournaments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tournaments_game_type_idx" ON "tournaments" USING btree ("game_type");--> statement-breakpoint
CREATE INDEX "treasury_flows_status_idx" ON "treasury_flows" USING btree ("status");--> statement-breakpoint
CREATE INDEX "treasury_flows_created_idx" ON "treasury_flows" USING btree ("created_at");