import { z } from 'zod';

import { affixFamilySchema, affixTierSchema, raritySchema } from './items.js';

/**
 * Коэффициенты генерации лута. GDD §6.1, §6.2.
 *
 * Отдельная схема, а не часть `combatBalanceSchema`, потому что это
 * разные потребители: движок боя про веса выпадения ничего не знает
 * и знать не должен. Разбирается один раз при старте сервера — кривая
 * запись падает там, а не всплывает как `undefined` в предмете игрока.
 */

const tierRange = z.tuple([z.number(), z.number()]);

const ladderSchema = z.object({
  T1: tierRange,
  T2: tierRange,
  T3: tierRange,
  T4: tierRange,
  T5: tierRange,
});

const byTier = z.object({
  T1: z.number().min(0),
  T2: z.number().min(0),
  T3: z.number().min(0),
  T4: z.number().min(0),
  T5: z.number().min(0),
});

export const lootBalanceSchema = z.object({
  ilvlScale: z.number(),
  /** Минимальный ilvl каждого тира. GDD §6.1. */
  affixTierMinIlvl: z.object({
    T1: z.int().min(1),
    T2: z.int().min(1),
    T3: z.int().min(1),
    T4: z.int().min(1),
    T5: z.int().min(1),
  }),
  /** Диапазон числа аффиксов по редкости. GDD §6.2. */
  affixCountByRarity: z.record(raritySchema, z.tuple([z.int().min(0), z.int().min(0)])),
  affixFamilies: z.object({
    might: ladderSchema,
    strength: ladderSchema,
  }),
  mightBudget: z.int().min(1),
  capacity: z.object({ inv: z.int().min(1), stash: z.int().min(1) }),
  sell: z.object({
    base: z.number().min(0),
    rarityMultiplier: z.record(raritySchema, z.number().min(0)),
  }),
  drop: z.object({
    rarityWeights: z.record(raritySchema, z.number().min(0)),
    familyWeights: z.record(affixFamilySchema, z.number().min(0)),
    tierWeights: byTier,
  }),
});
export type LootBalance = z.infer<typeof lootBalanceSchema>;

export type { AffixTier } from './items.js';
export { affixTierSchema };
