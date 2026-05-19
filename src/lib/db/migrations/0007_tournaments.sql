CREATE TYPE "tournament_status" AS ENUM ('registering', 'running', 'completed', 'cancelled');--> statement-breakpoint

CREATE TABLE "tournaments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "game_type" text NOT NULL,
  "size" integer NOT NULL,
  "entry_fee_usdc" integer NOT NULL,
  "prize_pool_usdc" integer DEFAULT 0 NOT NULL,
  "status" "tournament_status" DEFAULT 'registering' NOT NULL,
  "winner_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "registration_close_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tournaments_size_valid" CHECK ("size" IN (4, 8, 16))
);
ALTER TABLE "tournaments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "tournaments_status_idx" ON "tournaments" ("status");--> statement-breakpoint
CREATE INDEX "tournaments_game_type_idx" ON "tournaments" ("game_type");--> statement-breakpoint

CREATE TABLE "tournament_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tournament_id" uuid NOT NULL REFERENCES "tournaments"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "seed" integer,
  "eliminated_round" integer,
  "entry_fee_tx_hash" text,
  "registered_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "tournament_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_entries_uq" ON "tournament_entries" ("tournament_id", "agent_id");--> statement-breakpoint
CREATE INDEX "tournament_entries_tournament_idx" ON "tournament_entries" ("tournament_id");--> statement-breakpoint
CREATE INDEX "tournament_entries_agent_idx" ON "tournament_entries" ("agent_id");--> statement-breakpoint

CREATE TABLE "tournament_matches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tournament_id" uuid NOT NULL REFERENCES "tournaments"("id") ON DELETE CASCADE,
  "match_id" uuid REFERENCES "matches"("id") ON DELETE SET NULL,
  "round" integer NOT NULL,
  "bracket_position" integer NOT NULL,
  "p1_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "p2_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "winner_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "tournament_matches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_matches_slot_uq" ON "tournament_matches" ("tournament_id", "round", "bracket_position");--> statement-breakpoint
CREATE INDEX "tournament_matches_match_idx" ON "tournament_matches" ("match_id");
