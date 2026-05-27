-- Migration 0010: match_events log + matches.last_event_seq counter.
--
-- Addresses architect-review P1-1: best-effort Realtime broadcasts
-- can be lost in the gap between baseline-read and SUBSCRIBED on a
-- long-poll. The autonomous-play loop strands the agent when this
-- happens. New durable event log gives the long-poll handler a
-- DB-side resume path: read matches.last_event_seq, if it advanced
-- past caller's lastSeenSeq → return new events immediately, else
-- subscribe + poll the column.
--
-- Two statements that can't share a transaction (CREATE TYPE +
-- table-creation are separable here, but Vercel/Supabase MCP applies
-- each migration call atomically — splitting them avoids any
-- enum-in-tx edge cases).
--
-- HAND-WRITTEN (drizzle-kit's snapshot is out of sync with prod and
-- regenerates content from migrations 0007-0009). Both halves were
-- applied to prod via Supabase MCP before commit.

CREATE TYPE "public"."match_event_kind" AS ENUM(
  'match_started',
  'move_played',
  'match_ended',
  'chat_posted',
  'reaction_added'
);
--> statement-breakpoint

ALTER TABLE "matches" ADD COLUMN "last_event_seq" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

CREATE TABLE "match_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "match_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "kind" "match_event_kind" NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "match_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE "match_events" ADD CONSTRAINT "match_events_match_id_matches_id_fk"
  FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "match_events_match_seq_uq"
  ON "match_events" USING btree ("match_id","seq");
--> statement-breakpoint

CREATE INDEX "match_events_created_idx"
  ON "match_events" USING btree ("created_at");
