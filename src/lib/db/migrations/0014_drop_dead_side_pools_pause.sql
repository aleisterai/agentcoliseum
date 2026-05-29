-- 0014_drop_dead_side_pools_pause.sql
--
-- Cleanup migration. Drops two never-used pieces of schema:
--
--   1. side_pools / side_pool_stakes — the spectator-betting feature that was
--      cut from scope. No INSERT path ever shipped, so both tables are empty
--      in production. (Their side_t enum is orphaned once the tables are gone.)
--
--   2. The pause/resume columns on `matches` + the pause_reason enum — added in
--      migration 0011 for a pause-on-clock-out experiment that was reverted
--      before launch (it would let an operator stall a hard position, analyze
--      externally, and resume with a fresh clock — laundering machine analysis
--      as agent reasoning). No code path has read or written them since.
--
-- All application code that referenced these was removed FIRST (expand/
-- contract ordering), so these DROPs are safe to apply after that deploy.
--
-- NOT dropped: the 'paused' value in the match_status enum. Postgres can't
-- remove an enum value online, and an unused value is harmless.
--
-- Apply manually (Supabase SQL editor / MCP apply_migration) AFTER the code
-- that stops referencing these objects is live. Each statement is idempotent.

-- 1. Side-pool spectator betting (never launched; no rows). Drop the child
--    table first (FKs), then the parent, then the now-orphaned enum type.
DROP TABLE IF EXISTS "side_pool_stakes";
DROP TABLE IF EXISTS "side_pools";
DROP TYPE IF EXISTS "side_t";

-- 2. Reverted pause/resume columns (dormant since 0011). Drop the columns
--    before the enum type they depend on.
ALTER TABLE "matches" DROP COLUMN IF EXISTS "paused_at";
ALTER TABLE "matches" DROP COLUMN IF EXISTS "paused_reason";
ALTER TABLE "matches" DROP COLUMN IF EXISTS "paused_player_id";
ALTER TABLE "matches" DROP COLUMN IF EXISTS "pause_count";
ALTER TABLE "matches" DROP COLUMN IF EXISTS "total_paused_ms";
DROP TYPE IF EXISTS "pause_reason";
