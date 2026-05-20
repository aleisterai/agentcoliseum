CREATE TYPE "public"."game_mode" AS ENUM('free', 'paid', 'system');--> statement-breakpoint
CREATE TYPE "public"."game_status" AS ENUM('lobby', 'active', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."game_type" AS ENUM('connect4');--> statement-breakpoint
CREATE TYPE "public"."system_bot_difficulty" AS ENUM('easy', 'medium', 'hard');--> statement-breakpoint
CREATE TYPE "public"."tier" AS ENUM('none', 'play', 'initiator');--> statement-breakpoint
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_handle_unique" UNIQUE("handle"),
	CONSTRAINT "agents_api_key_unique" UNIQUE("api_key")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "game_type" DEFAULT 'connect4' NOT NULL,
	"mode" "game_mode" NOT NULL,
	"status" "game_status" DEFAULT 'lobby' NOT NULL,
	"initiator_agent_id" uuid,
	"acceptor_agent_id" uuid,
	"system_bot_difficulty" "system_bot_difficulty",
	"stake_usdc" integer,
	"pot_usdc" integer,
	"platform_fee_usdc" integer,
	"board_state" jsonb NOT NULL,
	"current_turn_agent_id" uuid,
	"winner_agent_id" uuid,
	"move_timeout_sec" integer DEFAULT 30 NOT NULL,
	"last_move_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"agent_id" uuid,
	"move_number" integer NOT NULL,
	"column" integer NOT NULL,
	"board_state_after" jsonb NOT NULL,
	"thinking_ms" integer NOT NULL,
	"x402_payment_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "tier_cache" (
	"wallet_address" text PRIMARY KEY NOT NULL,
	"balance_wei" text NOT NULL,
	"tier" "tier" NOT NULL,
	"cached_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treasury_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid,
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
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_initiator_agent_id_agents_id_fk" FOREIGN KEY ("initiator_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_acceptor_agent_id_agents_id_fk" FOREIGN KEY ("acceptor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_current_turn_agent_id_agents_id_fk" FOREIGN KEY ("current_turn_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_winner_agent_id_agents_id_fk" FOREIGN KEY ("winner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moves" ADD CONSTRAINT "moves_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moves" ADD CONSTRAINT "moves_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_flows" ADD CONSTRAINT "treasury_flows_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_owner_idx" ON "agents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "agents_elo_idx" ON "agents" USING btree ("elo");--> statement-breakpoint
CREATE INDEX "games_status_idx" ON "games" USING btree ("status");--> statement-breakpoint
CREATE INDEX "games_mode_idx" ON "games" USING btree ("mode");--> statement-breakpoint
CREATE INDEX "games_initiator_idx" ON "games" USING btree ("initiator_agent_id");--> statement-breakpoint
CREATE INDEX "games_acceptor_idx" ON "games" USING btree ("acceptor_agent_id");--> statement-breakpoint
CREATE INDEX "games_current_turn_idx" ON "games" USING btree ("current_turn_agent_id");--> statement-breakpoint
CREATE INDEX "games_created_idx" ON "games" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "moves_game_move_idx" ON "moves" USING btree ("game_id","move_number");--> statement-breakpoint
CREATE INDEX "moves_game_created_idx" ON "moves" USING btree ("game_id","created_at");--> statement-breakpoint
CREATE INDEX "owners_wallet_lower_idx" ON "owners" USING btree (lower("wallet_address"));--> statement-breakpoint
CREATE INDEX "tier_cache_age_idx" ON "tier_cache" USING btree ("cached_at");--> statement-breakpoint
CREATE INDEX "treasury_flows_status_idx" ON "treasury_flows" USING btree ("status");--> statement-breakpoint
CREATE INDEX "treasury_flows_created_idx" ON "treasury_flows" USING btree ("created_at");