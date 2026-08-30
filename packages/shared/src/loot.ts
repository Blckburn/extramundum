import { z } from 'zod';

import {
  affixFamilySchema,
  affixTierSchema,
  equipmentSlotSchema,
  raritySchema,
  type Rarity,
} from './items.js';

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
  /**
   * Умножается ли скатанное значение на `1 + ilvl × 0.04` при генерации.
   *
   * ОБЯЗАТЕЛЬНОЕ поле, а не флаг с умолчанием: забытое умолчание здесь
   * молча обнуляет семейство к высоким уровням (см. `$scalesWithIlvl`
   * в balance.json), а выглядит это как «аффикс просто слабоват».
   */
  scalesWithIlvl: z.boolean(),
  /**
   * Процентное семейство (множитель) или плоское (слагаемое).
   *
   * В данных, а не выведено по имени семейства в коде: ветка
   * `family === 'strength'` в генераторе — это коэффициент, захардкоженный
   * в логике, то есть баг по инварианту 5. Что список здесь совпадает
   * с `PERCENT_AFFIX_FAMILIES`, проверяет тест: два источника правды
   * расходятся молча.
   */
  percent: z.boolean(),
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
    fortitude: ladderSchema,
    bastion: ladderSchema,
    vitality: ladderSchema,
    swiftness: ladderSchema,
    truehand: ladderSchema,
  }),
  familyBudget: z.object({
    might: z.int().min(1),
    bastion: z.int().min(1),
    swiftness: z.int().min(1),
  }),
  capacity: z.object({ inv: z.int().min(1), stash: z.int().min(1) }),
  sell: z.object({
    base: z.number().min(0),
    rarityMultiplier: z.record(raritySchema, z.number().min(0)),
    /**
     * Прибавка к цене за аффикс, по тиру. GDD §6.3.
     *
     * Без неё два эпика — один с четырьмя T1, другой с четырьмя T5 —
     * стоили бы одинаково, и читать аффиксы перед массовой продажей
     * было бы незачем. А фильтр и замок существуют ровно затем,
     * чтобы игрок читал.
     */
    affixTierBonus: byTier,
  }),
  drop: z.object({
    /**
     * Веса редкости ПО УМОЛЧАНИЮ — для источников, у которых нет
     * убитого врага: стартовый набор, набор разработки, тесты.
     * Лут из боя считает веса по уровню монстра (`rarityByLevel`).
     */
    rarityWeights: z.record(raritySchema, z.number().min(0)),
    /**
     * Веса редкости для лута ИЗ БОЯ: `base + perLevel × уровень монстра`.
     *
     * Редкость приходит от силы врага, а не сыплется ровным потоком.
     * На живых сессиях ровный поток и оказался причиной, по которой лут
     * перестал быть решением: «смотришь на калькулятор и ждёшь зелёные
     * цифры».
     */
    rarityByLevel: z.record(
      raritySchema,
      z.object({ base: z.number().min(0), perLevel: z.number() }),
    ),
    /**
     * Добавка к весам, которую даёт ТОЛЬКО босс.
     *
     * Эпик и легендарка живут здесь, а не в `rarityByLevel`: обычный
     * монстр не роняет их вовсе. Это заодно чинит эвакуацию — босс стоит
     * на пятом бою, значит идти до конца осмысленно из-за ДОСТУПА
     * К КАТЕГОРИИ лута, а не из-за множителя количества.
     *
     * Легендарка по-прежнему выключена нулём (нет уникальных
     * модификаторов, GDD §6.2), но проходит по той же ветке: включение
     * остаётся правкой одного числа.
     */
    bossRarityBonus: z.record(raritySchema, z.number().min(0)),
    familyWeights: z.record(affixFamilySchema, z.number().min(0)),
    /**
     * Какие семейства вообще могут выпасть на слоте. GDD §5.3.
     *
     * Это и есть роль слота: пока списка не было, кольцо, амулет
     * и наручи отличались друг от друга только наличием брони.
     * Слот без записи — ошибка данных, а не «любое семейство»:
     * молча разрешить всё значило бы стереть роли обратно.
     */
    slotFamilies: z.record(equipmentSlotSchema, z.array(affixFamilySchema).min(1)),
    tierWeights: byTier,
  }),
});
export type LootBalance = z.infer<typeof lootBalanceSchema>;

export type { AffixTier } from './items.js';
export { affixTierSchema };

/**
 * Веса редкости для предмета, выпавшего с конкретного врага. GDD §6.2.
 *
 * ЧИСТАЯ ФУНКЦИЯ И ОДНА НА ВСЕХ: её зовёт и сервер при выдаче лута,
 * и матрица при замере плотности. Вторая реализация разошлась бы,
 * и замер мерил бы не то, что получает игрок.
 *
 * Отрицательный вес не бывает: `common` убывает с уровнем и на глубоких
 * зонах ушёл бы в минус, а минус во взвешенном выборе — это не «реже»,
 * а сдвиг всей выборки.
 */
export function rarityWeightsFor(
  level: number,
  isBoss: boolean,
  drop: LootBalance['drop'],
): Partial<Record<Rarity, number>> {
  const out: Partial<Record<Rarity, number>> = {};

  for (const [rarity, curve] of Object.entries(drop.rarityByLevel)) {
    const bonus = isBoss ? (drop.bossRarityBonus[rarity as Rarity] ?? 0) : 0;
    out[rarity as Rarity] = Math.max(0, curve.base + curve.perLevel * level) + bonus;
  }

  return out;
}
