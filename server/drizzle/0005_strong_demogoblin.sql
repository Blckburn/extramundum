-- Забеги получают собственный сид и заряды зелий (M3b, GDD §7.2).
--
-- Столбец `seed` добавляется СО ЗНАЧЕНИЕМ ПО УМОЛЧАНИЮ, которое тут же
-- снимается. Таблица сейчас пуста — механики забега до M3b не было, —
-- но `ADD COLUMN ... NOT NULL` без умолчания падает на любой непустой
-- таблице, а миграция обязана быть применимой везде, а не только там,
-- где её сегодня запускают.
ALTER TABLE "runs" ADD COLUMN "seed" text NOT NULL DEFAULT gen_random_uuid()::text;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "seed" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "potions_left" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_potions_non_negative" CHECK ("runs"."potions_left" >= 0);
