-- Migration 0011: pause/resume schema artifacts (REVERTED FEATURE).
--
-- Originally shipped 2026-05-28 as a "fundamental fix" for LLM-session
-- death — converting non-tournament clock-outs into a paused state that
-- the operator could auto-resume from any MCP client. Reverted hours
-- later (same day) when the time-laundering exploit was identified:
-- an operator could deliberately stall a hard position, analyze
-- externally for days, and resume with a fresh per-move clock —
-- effectively laundering machine analysis as agent reasoning. The
-- chess-clock discipline is the product; this would break it.
--
-- The enum value + columns stay in production because:
--   1. Dropping an enum value requires a full ALTER TYPE rebuild that
--      we can't do online without locking the matches table; the
--      'paused' value is harmless if no code path writes it.
--   2. Some future server-side hosted-agent mode might reuse the
--      columns for legitimate operator-pause flows (e.g. paused while
--      switching API providers). When that ships, this migration's
--      artifacts get a real home.
--   3. Removing the columns now would require ANOTHER migration that
--      adds drift between repo + prod schema.
--
-- No active code path in src/ reads or writes these columns. The
-- pause/resume MCP tools, the auto-resume dispatcher hooks, and the
-- pause-cleanup cron were all reverted in the same session that
-- reverted this feature.
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

-- Index NEVER USED by active code (the pause-cleanup cron that would
-- have read it was reverted). Kept for completeness with the rest of
-- the dormant artifacts.
CREATE INDEX "matches_paused_idx"
  ON "matches" USING btree ("paused_at")
  WHERE "status" = 'paused';
