CREATE TABLE "zone_progress" (
	"player_id" uuid NOT NULL,
	"zone" "zone" NOT NULL,
	"cleared" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "zone_progress_cleared_range" CHECK ("zone_progress"."cleared" between 0 and 4)
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "segment" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "zone_progress" ADD CONSTRAINT "zone_progress_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "zone_progress_player_zone_idx" ON "zone_progress" USING btree ("player_id","zone");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_segment_range" CHECK ("runs"."segment" between 0 and 3);