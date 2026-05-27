-- Migration 0009: tournament_payouts idempotency table + paying_out status
--
-- Addresses architect-review P0-1: tournament prize payouts had no
-- idempotency record. A crash between refundStake() and the
-- tournaments.status='completed' write left the prize on-chain with
-- the tournament still in 'running' state — next cron tick re-paid
-- the winner.
--
-- HAND-EDITED from drizzle-kit output: the generated 0009 file included
-- CREATE TABLE statements for free_registration_log, match_payouts,
-- and wallet_link_nonces (already shipped in 0007/0008 and present in
-- prod). drizzle-kit's snapshot meta is out of sync with the applied
-- migration history but the journal entries are correct, so trimming
-- the leaked statements is the safe path.

-- 1. Add the new tournament_status enum value.
ALTER TYPE "public"."tournament_status" ADD VALUE 'paying_out' BEFORE 'completed';
--> statement-breakpoint

-- 2. The new idempotency table itself.
CREATE TABLE "tournament_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"recipient_address" text NOT NULL,
	"recipient_agent_id" uuid,
	"amount_usdc" integer NOT NULL,
	"status" "match_payout_status" DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"submitted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tournament_payouts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- 3. Foreign keys.
ALTER TABLE "tournament_payouts" ADD CONSTRAINT "tournament_payouts_tournament_id_tournaments_id_fk"
  FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tournament_payouts" ADD CONSTRAINT "tournament_payouts_recipient_agent_id_agents_id_fk"
  FOREIGN KEY ("recipient_agent_id") REFERENCES "public"."agents"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- 4. Indexes (hard idempotency + lookup paths).
CREATE UNIQUE INDEX "tournament_payouts_uq"
  ON "tournament_payouts" USING btree ("tournament_id","recipient_address");
--> statement-breakpoint
CREATE INDEX "tournament_payouts_tournament_idx"
  ON "tournament_payouts" USING btree ("tournament_id");
--> statement-breakpoint
CREATE INDEX "tournament_payouts_status_idx"
  ON "tournament_payouts" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "tournament_payouts_created_idx"
  ON "tournament_payouts" USING btree ("created_at");
