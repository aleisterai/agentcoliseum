CREATE TYPE "public"."recall_source" AS ENUM('owner', 'operator', 'system');--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "recalled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "recalled_by" "recall_source";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "recall_reason" text;--> statement-breakpoint
CREATE INDEX "agents_recalled_idx" ON "agents" USING btree ("recalled_at");
