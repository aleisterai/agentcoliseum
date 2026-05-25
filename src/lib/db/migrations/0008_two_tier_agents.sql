-- Two-tier autonomous-onboarding schema (2026-05).
--
-- Adds the wallet-link + paid-games-counter infrastructure to agents so
-- the new `npx @agentcoliseum/init` registration flow can mint free
-- agents that later upgrade to paid play by linking a wallet holding
-- 20M+ $ALEISTER (Play tier) or 50M+ (Initiator tier). The token CA on
-- Base is 0xacb4543f479ea44e6df4fa01e483bb5b78361ba3.

-- ── agents: link wallet + counter + nullable owner ─────────────────────

ALTER TABLE "agents" ALTER COLUMN "owner_id" DROP NOT NULL;

ALTER TABLE "agents" ADD COLUMN "linked_wallet_address" text;
ALTER TABLE "agents" ADD COLUMN "linked_wallet_signed_at" timestamptz;
ALTER TABLE "agents" ADD COLUMN "wallet_link_signature" text;
ALTER TABLE "agents" ADD COLUMN "paid_games_played" integer NOT NULL DEFAULT 0;

CREATE INDEX "agents_linked_wallet_idx"
  ON "agents" ("linked_wallet_address");

-- Backfill: every existing agent has an owner today. Set
-- linked_wallet_address = owner.wallet_address so their tier check
-- works without re-linking. New free-tier agents land with NULL.
UPDATE "agents" SET "linked_wallet_address" = "owners"."wallet_address"
  FROM "owners"
  WHERE "agents"."owner_id" = "owners"."id"
    AND "agents"."linked_wallet_address" IS NULL;

-- ── wallet_link_nonces ─────────────────────────────────────────────────
--
-- Short-lived nonces (5 min TTL) the agent gets from
-- coliseum_agent_wallet_link_request and the operator signs via
-- personal_sign. Once `consumed_at` is set, the nonce is dead.

CREATE TABLE IF NOT EXISTS "wallet_link_nonces" (
  "nonce" text PRIMARY KEY,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "issued_at" timestamptz NOT NULL DEFAULT NOW(),
  "consumed_at" timestamptz
);

ALTER TABLE "wallet_link_nonces" ENABLE ROW LEVEL SECURITY;

CREATE INDEX "wallet_link_nonces_agent_idx"
  ON "wallet_link_nonces" ("agent_id");
CREATE INDEX "wallet_link_nonces_issued_idx"
  ON "wallet_link_nonces" ("issued_at");

-- ── free_registration_log ──────────────────────────────────────────────
--
-- Audit trail for /api/agents/register/free + per-IP rate-limit anchor
-- (3 reg/hour, 100/day enforced in the route). ip_hash is sha256 to
-- avoid storing raw PII.

CREATE TABLE IF NOT EXISTS "free_registration_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ip_hash" text NOT NULL,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE CASCADE,
  "pow_difficulty" integer NOT NULL,
  "user_agent_hash" text,
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE "free_registration_log" ENABLE ROW LEVEL SECURITY;

CREATE INDEX "free_reg_ip_recency_idx"
  ON "free_registration_log" ("ip_hash", "created_at");
CREATE INDEX "free_reg_created_idx"
  ON "free_registration_log" ("created_at");
