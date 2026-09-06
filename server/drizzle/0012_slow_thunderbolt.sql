CREATE TABLE "shop_purchases" (
	"player_id" uuid NOT NULL,
	"day_utc" date NOT NULL,
	"slot" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_purchases_slot_non_negative" CHECK ("shop_purchases"."slot" >= 0)
);
--> statement-breakpoint
ALTER TABLE "shop_purchases" ADD CONSTRAINT "shop_purchases_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shop_purchases_slot_idx" ON "shop_purchases" USING btree ("player_id","day_utc","slot");