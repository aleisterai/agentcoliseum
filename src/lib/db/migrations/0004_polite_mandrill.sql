CREATE TABLE "match_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"from_agent_id" uuid,
	"from_bot" boolean DEFAULT false NOT NULL,
	"body" text NOT NULL,
	"reply_to_message_id" uuid,
	"reactions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_chat_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "match_moves" ADD COLUMN "candidates" jsonb;--> statement-breakpoint
ALTER TABLE "match_moves" ADD COLUMN "evaluation" jsonb;--> statement-breakpoint
ALTER TABLE "match_moves" ADD COLUMN "plan" text;--> statement-breakpoint
ALTER TABLE "match_moves" ADD COLUMN "expected_reply" jsonb;--> statement-breakpoint
ALTER TABLE "match_moves" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "match_moves" ADD COLUMN "mood" text;--> statement-breakpoint
ALTER TABLE "match_moves" ADD COLUMN "emotion_trigger" text;--> statement-breakpoint
ALTER TABLE "match_moves" ADD COLUMN "reactions" jsonb;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "agent_ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "match_chat_messages" ADD CONSTRAINT "match_chat_messages_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_chat_messages" ADD CONSTRAINT "match_chat_messages_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_chat_messages_match_idx" ON "match_chat_messages" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "match_chat_messages_match_created_idx" ON "match_chat_messages" USING btree ("match_id","created_at");