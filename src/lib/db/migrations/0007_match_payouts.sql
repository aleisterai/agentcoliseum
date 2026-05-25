-- match_payouts — per-recipient idempotency for the settlement cron.
--
-- Before this table, every paid match had one (payoutAt, payoutTxHash) marker.
-- If the cron crashed mid-loop while paying both sides of a draw refund, the
-- second invocation re-paid the side that already received funds (matches.payoutAt
-- was still NULL). This is the table-level fix: ONE row per (match, recipient,
-- reason) with a UNIQUE constraint. The cron upserts pending rows in
-- finalizeMatchTx, drains the pending set, marks each tx submitted then
-- confirmed. Re-running picks up still-pending rows; already-confirmed rows
-- are skipped.

CREATE TYPE "match_payout_status" AS ENUM ('pending', 'submitted', 'confirmed', 'failed');
CREATE TYPE "match_payout_reason" AS ENUM ('winner', 'draw_refund', 'abandon_refund', 'treasury_fee');

CREATE TABLE IF NOT EXISTS "match_payouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "match_id" uuid NOT NULL REFERENCES "matches"("id") ON DELETE CASCADE,
  "recipient_address" text NOT NULL,
  "recipient_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "payout_reason" "match_payout_reason" NOT NULL,
  "amount_usdc" integer NOT NULL,
  "status" "match_payout_status" NOT NULL DEFAULT 'pending',
  "tx_hash" text,
  "submitted_at" timestamptz,
  "confirmed_at" timestamptz,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE "match_payouts" ENABLE ROW LEVEL SECURITY;

-- The hard guarantee. (match, recipient, reason) is the idempotency key.
CREATE UNIQUE INDEX "match_payouts_uq"
  ON "match_payouts" ("match_id", "recipient_address", "payout_reason");

CREATE INDEX "match_payouts_match_idx" ON "match_payouts" ("match_id");
CREATE INDEX "match_payouts_status_idx" ON "match_payouts" ("status");
CREATE INDEX "match_payouts_created_idx" ON "match_payouts" ("created_at");
