-- Migration 0011: pause/resume — fundamental fix for the 5 LLM-session
-- failure modes (Claude Desktop closed, context overflowed, autonomous
-- loop crashed, tool-approval prompts unapproved, long-poll wakes missed).
--
-- Before this migration, a clock expiry → `time_forfeit + opponent wins`.
-- That meant any operator-side mishap (a closed laptop lid, a context-roll
-- in Claude Desktop, a crashed cron) lost the agent the match AND the
-- stake. The owner had no recovery path.
--
-- After this migration, non-tournament matches transition to a new
-- `paused` status instead. The opponent does NOT win; the stake stays
-- locked; the match holds its exact position. The paused agent's owner
-- can restart their session and call `coliseum_match_resume({matchId})`
-- to put the match back to `active` with a fresh clock.
--
-- Limits (enforced by the new pause-cleanup cron, NOT this migration):
--   - 3 pauses by the same side → opponent wins by `time_forfeit`
--   - Paused > 7 days → match finalized as `abandoned`, stakes refunded
--
-- Tournament matches keep current `time_forfeit` behavior so spectator
-- timing constraints are preserved (the cron checks `tournament_match`
-- via the `tournament_match_id` foreign key on matches).
--
-- HAND-WRITTEN (drizzle-kit's snapshot has drifted; this migration
-- ships the additive enum value + columns + index directly).
--
-- The `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block,
-- so the migration is split into two halves applied separately via the
-- Supabase MCP (0011a = enum; 0011b = columns + index).

-- 0011a: enum value
ALTER TYPE "public"."match_status" ADD VALUE 'paused' BEFORE 'completed';
--> statement-breakpoint

-- 0011b: pause-reason enum + columns + index
CREATE TYPE "public"."pause_reason" AS ENUM(
  'idle_timeout',
  'operator_pause'
);
--> statement-breakpoint

ALTER TABLE "matches"
  ADD COLUMN "paused_at" timestamp with time zone,
  ADD COLUMN "paused_reason" "pause_reason",
  ADD COLUMN "paused_player_id" "player_id_t",
  ADD COLUMN "pause_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "total_paused_ms" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- Index used by the pause-cleanup cron to find paused matches whose
-- 7-day window has elapsed, and to find matches awaiting resume by
-- a given player.
CREATE INDEX "matches_paused_idx"
  ON "matches" USING btree ("paused_at")
  WHERE "status" = 'paused';
