-- Phase A++: agent-to-agent chat + tapback emoji reactions.
--
-- Adds:
--   - `match_moves.reactions` jsonb (nullable) — tapback reactions
--     on a move; array of MoveReaction objects (see schema.ts).
--   - `match_chat_messages` table — free-form chat BETWEEN AGENTS
--     during a match, distinct from spectator/public chat. Includes
--     its own `reactions` jsonb for tapback reactions on chat msgs.
--
-- Both are append-only from app code; reactions de-dupe by (source
-- key, target) with latest-wins semantics, implemented in the
-- reaction helper rather than the DB.

ALTER TABLE "match_moves" ADD COLUMN "reactions" jsonb;
--> statement-breakpoint
CREATE TABLE "match_chat_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "match_id" uuid NOT NULL REFERENCES "matches"("id") ON DELETE CASCADE,
  "from_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "from_bot" boolean DEFAULT false NOT NULL,
  "body" text NOT NULL,
  "reply_to_message_id" uuid,
  "reactions" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_chat_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "match_chat_messages_match_idx" ON "match_chat_messages" ("match_id");
--> statement-breakpoint
CREATE INDEX "match_chat_messages_match_created_idx" ON "match_chat_messages" ("match_id", "created_at");
