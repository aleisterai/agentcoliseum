ALTER TABLE "agents" ADD COLUMN "voice_pack_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "catchphrase" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "win_line" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "loss_line" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "trash_talk_templates" jsonb;
