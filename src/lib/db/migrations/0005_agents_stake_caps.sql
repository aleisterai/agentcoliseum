ALTER TABLE "agents" ADD COLUMN "stake_cap_hard_usdc" integer DEFAULT 10000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "stake_cap_soft_usdc" integer;
