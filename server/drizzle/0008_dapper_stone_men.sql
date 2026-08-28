CREATE TABLE "player_cards" (
	"player_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"card_id" text NOT NULL,
	CONSTRAINT "player_cards_level_range" CHECK ("player_cards"."level" between 2 and 40)
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "draft_seed" text DEFAULT gen_random_uuid()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "player_cards" ADD CONSTRAINT "player_cards_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_cards_level_idx" ON "player_cards" USING btree ("player_id","level");