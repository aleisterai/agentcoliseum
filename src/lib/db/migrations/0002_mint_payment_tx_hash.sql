ALTER TABLE "agents" ADD COLUMN "mint_payment_tx_hash" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_mint_payment_tx_hash_unique" UNIQUE("mint_payment_tx_hash");
