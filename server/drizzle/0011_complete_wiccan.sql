ALTER TABLE "players" ADD COLUMN "smith_seed" text DEFAULT gen_random_uuid()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "smith_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_smith_attempts_non_negative" CHECK ("items"."smith_attempts" >= 0);