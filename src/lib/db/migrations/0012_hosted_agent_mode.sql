-- Migration 0012: Hosted Agent Mode foundation.
--
-- New product surface: instead of the operator's LLM client (Claude
-- Desktop, Cursor, ChatGPT MCP, etc.) calling our MCP server, the
-- SERVER runs the autonomous loop using the owner's LLM API key. No
-- client-side session to die; no Claude Desktop window to close; no
-- autonomous-loop script for the operator to maintain. The chess
-- clock is still real — the agent thinks under the same deadline —
-- but the loop is bulletproof against operator-side failures.
--
-- Pricing (Sept 2026 launch):
--   Setup:    $1 USDC one-time, charged when the owner flips the
--             agent to hosted mode for the first time.
--   Monthly:  $20 USDC subscription, charged every 30 days. Failure
--             to pay → subscription expires, agent reverts to MCP
--             mode (or stays inactive until renewed).
--
-- Supported providers (designed for, not all shipped on day 1):
--   anthropic   — Claude family
--   openai      — GPT-4o, GPT-5, etc.
--   gemini      — Google Gemini
--   grok        — xAI Grok (OpenAI-compatible)
--   kimi        — Moonshot Kimi (OpenAI-compatible)
--   deepseek    — DeepSeek (OpenAI-compatible)
--
-- API keys are AES-256-GCM encrypted at rest using a master key from
-- the HOSTED_AGENT_KMS_KEY env var. The ciphertext + IV + auth tag
-- live in hosted_agent_configs; the master key never touches the
-- database. Decryption happens only in the hosted-agent worker
-- context; the key is never logged.
--
-- HAND-WRITTEN (drizzle-kit's snapshot has drifted).

-- 0012a: enum value (cannot share a tx with table-creation)
CREATE TYPE "public"."execution_mode" AS ENUM (
  'mcp',
  'hosted'
);
--> statement-breakpoint

-- 0012b: agents.execution_mode column + the two new tables
ALTER TABLE "agents"
  ADD COLUMN "execution_mode" "execution_mode" DEFAULT 'mcp' NOT NULL;
--> statement-breakpoint

CREATE TABLE "hosted_agent_configs" (
  "agent_id" uuid PRIMARY KEY NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "llm_provider" text NOT NULL,
  "llm_model" text NOT NULL,
  "api_key_encrypted" text NOT NULL,
  "api_key_iv" text NOT NULL,
  "api_key_tag" text NOT NULL,
  "system_prompt_extra" text,
  "last_call_at" timestamp with time zone,
  "last_error" text,
  "consecutive_errors" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "hosted_agent_configs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE TABLE "hosted_agent_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  -- Status: 'active' until expires_at; cron flips to 'expired' on lapse.
  -- 'cancelled' is set by the disable tool (no refund of partial month).
  "status" text NOT NULL DEFAULT 'active',
  -- microUSDC paid (setup = 1_000_000; monthly = 20_000_000)
  "paid_amount_usdc" bigint NOT NULL,
  -- On-chain tx hash for transparency / receipt; null for the rare
  -- admin-comp'd subscription (e.g. early-access waitlist).
  "payment_tx_hash" text,
  -- 'setup' (initial) | 'monthly' (renewal) — distinguishes the $1
  -- bootstrap from $20 recurring for analytics + UI rendering.
  "kind" text NOT NULL,
  "starts_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "hosted_agent_subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE INDEX "hosted_subs_agent_idx"
  ON "hosted_agent_subscriptions" USING btree ("agent_id");
--> statement-breakpoint

-- Partial index: cron joins on (status='active' AND expires_at < now())
CREATE INDEX "hosted_subs_active_expiry_idx"
  ON "hosted_agent_subscriptions" USING btree ("expires_at")
  WHERE "status" = 'active';
--> statement-breakpoint

-- Partial index: worker-cron loop selects hosted-mode agents whose
-- turn it is and who have an active subscription. The execution-mode
-- column is on the agents table; this index speeds the JOIN side.
CREATE INDEX "agents_hosted_mode_idx"
  ON "agents" USING btree ("id")
  WHERE "execution_mode" = 'hosted';
