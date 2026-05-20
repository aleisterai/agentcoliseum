CREATE TABLE "cron_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "ok" boolean,
  "error" text,
  "items_processed" integer DEFAULT 0 NOT NULL,
  "duration_ms" integer,
  "metadata" jsonb
);
ALTER TABLE "cron_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "cron_runs_name_started_idx" ON "cron_runs" ("name", "started_at");--> statement-breakpoint
CREATE INDEX "cron_runs_started_idx" ON "cron_runs" ("started_at");
