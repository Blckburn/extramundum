import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { battleResultEnum, difficultyEnum, runStateEnum, zoneEnum } from './enums.ts';
import { players } from './game.ts';

/**
 * runs — забеги с эвакуацией. GDD §3.3, §7.2.
 *
 * bag — «сумка забега»: лут, который ещё не попал в инвентарь. При смерти
 * теряется целиком. Именно эта таблица делает автобаттлер игрой про
 * оценку риска, поэтому её состояние живёт на сервере и только на сервере.
 */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),

    zone: zoneEnum('zone').notNull(),
    difficulty: difficultyEnum('difficulty').notNull(),
    /** Сколько боёв пройдено: 0..5 (GDD §7.2). */
    fightIndex: integer('fight_index').notNull().default(0),
    bag: jsonb('bag')
      .notNull()
      .default(sql`'[]'::jsonb`),
    state: runStateEnum('state').notNull().default('active'),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    // Активный забег у игрока может быть только один. Проверка на уровне
    // БД, а не кода: «не идёт ли уже рейд» — шаг 2 из GDD §3.2.
    uniqueIndex('runs_one_active_per_player_idx')
      .on(table.playerId)
      .where(sql`${table.state} = 'active'`),
    index('runs_player_idx').on(table.playerId),
    check('runs_fight_index_range', sql`${table.fightIndex} between 0 and 5`),
  ],
);

/**
 * battles — журналы боёв. GDD §3.3, §3.2.
 *
 * log хранится целиком, потому что он детерминирован и является
 * доказательством: по нему воспроизводится бой и строится реплей
 * по ссылке (GDD §3.2). seed хранится рядом — с ним лог перепроверяем.
 */
export const battles = pgTable(
  'battles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),

    /** Кто противник: ключ монстра или идентификатор снапшота арены. */
    opponentRef: text('opponent_ref').notNull(),
    /** Сид как текст: 64-битные значения не влезают в integer. */
    seed: text('seed').notNull(),
    log: jsonb('log').notNull(),
    result: battleResultEnum('result').notNull(),
    rewards: jsonb('rewards')
      .notNull()
      .default(sql`'{}'::jsonb`),

    /**
     * Бой проведён до появления прогрессии (M2b): наград нет,
     * состояние игрока не менялось.
     *
     * Колонка нужна не для игры, а для того, чтобы в M3 не пришлось
     * выяснять, почему часть боёв без наград — баг это или наследие.
     * Различить их постфактум по пустому `rewards` нельзя: проигранный
     * бой тоже может ничего не дать.
     */
    provisional: boolean('provisional').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('battles_player_created_idx').on(table.playerId, table.createdAt)],
);

/**
 * dailies — суточные счётчики. GDD §3.3, §8, §9.
 *
 * day_utc — дата СЕРВЕРА. В v1.0 сток магазина и попытки арены зависели
 * от new Date() в браузере: перевод часов давал новый сток, F5 давал
 * новые пять попыток (пункты 12 и 13 аудита). Здесь дату ставит сервер,
 * а счётчик попыток лежит в БД, а не в памяти вкладки.
 */
export const dailies = pgTable(
  'dailies',
  {
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    dayUtc: date('day_utc').notNull(),

    arenaLeft: integer('arena_left').notNull().default(5),
    quests: jsonb('quests')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Сид дневного магазина, тоже серверный. */
    shopSeed: text('shop_seed').notNull(),
  },
  (table) => [
    uniqueIndex('dailies_player_day_idx').on(table.playerId, table.dayUtc),
    check('dailies_arena_left_range', sql`${table.arenaLeft} between 0 and 5`),
  ],
);

/**
 * arena_ladder — рейтинг арены. GDD §3.3, §8.
 *
 * snapshot — копия билда игрока на момент попадания в таблицу. Соперник
 * сражается именно со снапшотом: арена асинхронная, живого противника
 * в бою нет.
 */
export const arenaLadder = pgTable(
  'arena_ladder',
  {
    seasonId: integer('season_id').notNull(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),

    elo: integer('elo').notNull().default(1000),
    wins: integer('wins').notNull().default(0),
    losses: integer('losses').notNull().default(0),
    snapshot: jsonb('snapshot').notNull(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('arena_ladder_season_player_idx').on(table.seasonId, table.playerId),
    // Матчмейкинг ищет соперников по ELO в окне ±150 (GDD §8).
    index('arena_ladder_season_elo_idx').on(table.seasonId, table.elo),
    check('arena_ladder_elo_non_negative', sql`${table.elo} >= 0`),
    check('arena_ladder_wins_non_negative', sql`${table.wins} >= 0`),
    check('arena_ladder_losses_non_negative', sql`${table.losses} >= 0`),
  ],
);
