ALTER TABLE "runs" ADD COLUMN "flasks_drunk" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "pending_status" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_flasks_drunk_non_negative" CHECK ("runs"."flasks_drunk" >= 0);