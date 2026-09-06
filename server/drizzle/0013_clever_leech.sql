CREATE TABLE "player_flasks" (
	"player_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"charges" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "player_flasks_non_negative" CHECK ("player_flasks"."charges" >= 0)
);
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_potions_non_negative";--> statement-breakpoint
ALTER TABLE "player_flasks" ADD CONSTRAINT "player_flasks_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_flasks_idx" ON "player_flasks" USING btree ("player_id","tier");--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "potions_left";