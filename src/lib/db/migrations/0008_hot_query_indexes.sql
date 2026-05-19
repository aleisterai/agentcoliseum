-- 0008 — indexes for the hot queries observed during Sprint 17 audit.
--
-- Each index here is justified by a specific query path in /api/* or
-- the cron handlers. CONCURRENTLY would be safer in prod but Supabase
-- migration runner doesn't support it inside a transaction, so we
-- accept the brief lock — the tables are small enough today that
-- the lock window is < 1s.

-- A. matches (last_move_at DESC) — spotlight + match.list (active matches
--    ordered by recency). Currently fell back to seq scan + sort.
CREATE INDEX IF NOT EXISTS "matches_last_move_at_idx"
  ON "matches" ("last_move_at" DESC NULLS LAST);--> statement-breakpoint

-- B. matches (completed_at DESC) — homepage Recent settlements, feed
--    events, agent profile recent matches, settlement sweep filter.
CREATE INDEX IF NOT EXISTS "matches_completed_at_idx"
  ON "matches" ("completed_at" DESC NULLS LAST);--> statement-breakpoint

-- C. Partial index: matches queued for settlement-sweep cron.
--    Selects matches WHERE status='completed' AND mode='paid' AND
--    payout_at IS NULL AND pot_usdc IS NOT NULL. A partial index
--    keeps this small (only rows the cron cares about) which means
--    the cron's index-only scan stays cheap as the matches table
--    grows.
CREATE INDEX IF NOT EXISTS "matches_pending_payout_idx"
  ON "matches" ("completed_at")
  WHERE "status" = 'completed' AND "mode" = 'paid' AND "payout_at" IS NULL;--> statement-breakpoint

-- D. Partial index: paid challenges with proposer escrow that haven't
--    been refunded. The refund-expired-challenges cron's selection.
CREATE INDEX IF NOT EXISTS "challenges_pending_refund_idx"
  ON "challenges" ("expires_at")
  WHERE "status" = 'posted'
    AND "mode" = 'paid'
    AND "proposer_stake_tx_hash" IS NOT NULL
    AND "proposer_stake_refund_tx_hash" IS NULL;--> statement-breakpoint

-- E. match_moves (agent_id, created_at) — agent profile activity feed
--    pulls last-N x402 moves WHERE agent_id = X. Without this it's
--    a seq scan + sort across all moves.
CREATE INDEX IF NOT EXISTS "match_moves_agent_created_idx"
  ON "match_moves" ("agent_id", "created_at" DESC);--> statement-breakpoint

-- F. tournament_matches (tournament_id, round) — bracket page renders
--    by round; tournament-progression cron scans by tournament_id +
--    sorts by round. tournament_matches_slot_uq already covers
--    (tournament_id, round, bracket_position) so this is partially
--    redundant — but explicit ordered scans pick the right plan.
--    Skipping to avoid index bloat; the existing uq is sufficient.

-- G. agents (last_mcp_at DESC NULLS LAST) — telemetry "active 24h"
--    + dashboard fleet sort. Modest table size so low-priority, but
--    keeps the activeLast24h count fast.
CREATE INDEX IF NOT EXISTS "agents_last_mcp_at_idx"
  ON "agents" ("last_mcp_at" DESC NULLS LAST);
