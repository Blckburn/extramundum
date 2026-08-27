ALTER TABLE "players" ADD COLUMN "base_armor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "base_accuracy" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
--
-- ДОБИВКА СУЩЕСТВУЮЩИХ, как миграция 0002 добивала номера изгнанных.
--
-- Нулевая база — это ровно тот баг, который правится: без неё игрок
-- входит в первую зону без брони. Оставить старые строки с нулём
-- значило бы починить игру только для тех, кто зарегистрируется после
-- деплоя, а разбираться потом пришлось бы по датам создания.
--
-- Числа — `balance.archetypes.forbidden` на момент миграции (броня 29,
-- точность 2). Это ИСТОРИЧЕСКАЯ ЗАПИСЬ, а не второе место, где живёт
-- баланс: новые строки берут значения из `ensurePlayer`, который
-- читает balance.json. Миграция описывает состояние в свой день
-- и меняться вслед за балансом не должна.
--
-- Условие на 0 нужно, чтобы повторный прогон не затирал ничего:
-- миграции идемпотентны по журналу, но осторожность здесь дешёвая.
UPDATE "players" SET "base_armor" = 29 WHERE "base_armor" = 0;--> statement-breakpoint
UPDATE "players" SET "base_accuracy" = 2 WHERE "base_accuracy" = 0;
