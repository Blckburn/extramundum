import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Перечисления БД. Держим их отдельно, потому что на них ссылаются
 * несколько таблиц, а drizzle-kit генерирует CREATE TYPE один раз.
 *
 * Значения дублируют константы из @extramundum/shared, и это осознанно:
 * пакет shared собирается для браузера, тянуть в него схему БД нельзя.
 * Совпадение наборов проверяется тестом server/src/db/__tests__.
 */

/** GDD §7.4. */
export const zoneEnum = pgEnum('zone', [
  'wastes',
  'warcamp',
  'catacombs',
  'forge',
  'abyss',
  'rift',
]);

/** GDD §7.3. */
export const difficultyEnum = pgEnum('difficulty', ['normal', 'dangerous', 'nightmare']);

/** GDD §5.3, восемь слотов. */
export const equipmentSlotEnum = pgEnum('equipment_slot', [
  'weapon',
  'offhand',
  'helmet',
  'chest',
  'bracers',
  'boots',
  'amulet',
  'ring',
]);

/** GDD §6.2. */
export const rarityEnum = pgEnum('rarity', ['common', 'magic', 'rare', 'epic', 'legendary']);

/** Где лежит предмет. GDD §3.3. */
export const containerEnum = pgEnum('container', ['inv', 'stash', 'equipped']);

/** Состояние забега. GDD §7.2. */
export const runStateEnum = pgEnum('run_state', ['active', 'extracted', 'wiped']);

/** Исход боя с точки зрения игрока. */
export const battleResultEnum = pgEnum('battle_result', ['win', 'loss']);

/**
 * Материалы. GDD §6.3.
 *
 * Пять тиров лома по границам зон плюс `ember` — высокий материал
 * для улучшений выше +5, падающий только на высоких сложностях.
 *
 * ПЕРЕЧИСЛЕНИЕМ, а не свободной строкой: материал с опечаткой в ключе
 * — это материал, которого нет ни у кого, и заметить его можно только
 * по жалобе «лом пропал».
 */
export const materialEnum = pgEnum('material', ['T1', 'T2', 'T3', 'T4', 'T5', 'ember']);
