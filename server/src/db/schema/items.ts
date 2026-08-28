import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { containerEnum, equipmentSlotEnum, rarityEnum } from './enums.ts';
import { players } from './game.ts';

/**
 * player_traits — выбранные трейты. GDD §3.3, §5.2.
 *
 * Трейт выдаётся каждый пятый уровень, слот — порядковый номер выбора.
 */
export const playerTraits = pgTable(
  'player_traits',
  {
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    traitId: text('trait_id').notNull(),
    slot: integer('slot').notNull(),
  },
  (table) => [
    uniqueIndex('player_traits_slot_idx').on(table.playerId, table.slot),
    // Один и тот же трейт нельзя взять дважды.
    uniqueIndex('player_traits_unique_idx').on(table.playerId, table.traitId),
    check('player_traits_slot_non_negative', sql`${table.slot} >= 0`),
  ],
);

/**
 * player_cards — что игрок выбрал в драфте. GDD §5.2.
 *
 * Хранятся ВЫБОРЫ, а не сумма прибавок, и это существенно. Из суммы
 * не восстановить наклон билда, а именно по нему фильтруется колода;
 * и респек (§5.2, следующий этап) — это удаление строк, а не обратная
 * арифметика, которая однажды не сойдётся.
 *
 * Уникальность по (игрок, уровень) — то же правило, что у слотов
 * экипировки: за один уровень выбирают ровно один раз, и это
 * выражается индексом, а не корректностью серверного кода. Повторный
 * запрос упрётся в базу, даже если проверка «до» его пропустит.
 */
export const playerCards = pgTable(
  'player_cards',
  {
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    /** Уровень, ЗА КОТОРЫЙ сделан выбор. Второй уровень — первая карта. */
    level: integer('level').notNull(),
    cardId: text('card_id').notNull(),
  },
  (table) => [
    uniqueIndex('player_cards_level_idx').on(table.playerId, table.level),
    check('player_cards_level_range', sql`${table.level} between 2 and 40`),
  ],
);

/**
 * items — предметы. GDD §3.3, §6.
 *
 * ilvl вынесен в отдельную колонку и участвует в расчёте силы предмета
 * (GDD §6.1). Это фикс провала v1.0, где легендарка 1 уровня была равна
 * легендарке 30 уровня.
 *
 * affixes — jsonb, и именно jsonb, а не строка с JSON внутри. Двойное
 * кодирование из v1.0 (пункт 15 аудита) здесь невозможно по типу колонки.
 */
export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),

    container: containerEnum('container').notNull().default('inv'),
    slotIndex: integer('slot_index'),

    /** Ключ базового типа: совпадает с ключом иконки в assets.json. */
    baseKey: text('base_key').notNull(),
    ilvl: integer('ilvl').notNull(),
    rarity: rarityEnum('rarity').notNull(),
    affixes: jsonb('affixes')
      .notNull()
      .default(sql`'[]'::jsonb`),
    upgradeLevel: integer('upgrade_level').notNull().default(0),

    /** Защита от случайной продажи и разбора. GDD §6.3. */
    locked: boolean('locked').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('items_owner_container_idx').on(table.ownerId, table.container),
    check('items_ilvl_range', sql`${table.ilvl} between 1 and 200`),
    check('items_upgrade_range', sql`${table.upgradeLevel} between 0 and 10`),
    check(
      'items_slot_index_non_negative',
      sql`${table.slotIndex} is null or ${table.slotIndex} >= 0`,
    ),
  ],
);

/**
 * equipment — что надето. GDD §3.3, §5.3.
 *
 * Отдельная таблица, а не колонка в items, потому что слот обязан быть
 * занят не более чем одним предметом — это выражается уникальностью
 * первичного ключа и не зависит от корректности серверного кода.
 */
export const equipment = pgTable(
  'equipment',
  {
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    slot: equipmentSlotEnum('slot').notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('equipment_player_slot_idx').on(table.playerId, table.slot),
    // Один предмет не может быть надет в два слота одновременно.
    uniqueIndex('equipment_item_idx').on(table.itemId),
  ],
);
