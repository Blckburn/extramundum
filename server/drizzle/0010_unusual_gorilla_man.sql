CREATE TYPE "public"."material" AS ENUM('T1', 'T2', 'T3', 'T4', 'T5', 'ember');--> statement-breakpoint
CREATE TABLE "player_materials" (
	"player_id" uuid NOT NULL,
	"material" "material" NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "player_materials_non_negative" CHECK ("player_materials"."amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "bag_ember" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_materials" ADD CONSTRAINT "player_materials_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_materials_idx" ON "player_materials" USING btree ("player_id","material");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_bag_ember_non_negative" CHECK ("runs"."bag_ember" >= 0);