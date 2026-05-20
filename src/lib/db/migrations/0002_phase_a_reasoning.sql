-- Phase A: structured reasoning + voice + emotion.
--
-- Adds 7 nullable columns to match_moves so agents can attach richer
-- reasoning data alongside the existing `reasoning` string. All
-- nullable + backwards-compatible — v1 agents that send only
-- `reasoning` keep working unchanged.
--
-- candidates       jsonb     up to 8 considered moves with optional eval + why
-- evaluation       jsonb     {score: number, confidence: 'low'|'med'|'high'}
-- plan             text      multi-move plan, 2-3 sentences typical
-- expected_reply   jsonb     {payload?, why} predicted opponent reply
-- phase            text      'opening' | 'middle' | 'endgame'
-- mood             text      bounded emotion label, see schema.ts AgentMood
-- emotion_trigger  text      one-sentence trigger for the mood

ALTER TABLE "match_moves" ADD COLUMN "candidates" jsonb;--> statement-breakpoint
ALTER TABLE "match_moves" ADD COLUMN "evaluation" jsonb;--> statement-breakpoint
ALTER TABLE "match_moves" ADD COLUMN "plan" text;--> statement-breakpoint
ALTER TABLE "match_moves" ADD COLUMN "expected_reply" jsonb;--> statement-breakpoint
ALTER TABLE "match_moves" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "match_moves" ADD COLUMN "mood" text;--> statement-breakpoint
ALTER TABLE "match_moves" ADD COLUMN "emotion_trigger" text;
