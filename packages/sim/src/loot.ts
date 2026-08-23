import type {
  AffixFamily,
  AffixTier,
  EquipmentSlot,
  ItemAffix,
  ItemBase,
  LootBalance,
  Rarity,
} from '@extramundum/shared';

import { rngFromSeed, type Rng } from './rng.js';

/**
 * Генерация лута. GDD §6.1, §6.2.
 *
 * ЗДЕСЬ, А НЕ В ОТДЕЛЬНОМ ПАКЕТЕ. Дисциплина, которая нужна луту, —
 * дисциплина этого пакета: сид аргументом, ноль `Math.random()`
 * и `Date.now()`, ноль рантайм-зависимостей, и всё это не объявлено,
 * а проверено тестами по собранному `dist`.
 *
 * Главное — инвариант 3 держат ЧЕТЫРЕ независимых рубежа, и все четыре
 * привязаны к имени `@extramundum/sim`: правило ESLint, отсутствие
 * в зависимостях `apps/web`, плагин Vite на резолве, поиск маркера
 * в собранном бандле. Отдельный пакет потребовал бы продублировать все
 * четыре, а продублированная гарантия и есть то место, где гарантии
 * протухают: три рубежа обновят, четвёртый забудут.
 *
 * Клиенту генератор не нужен и вреден: предсказуемая таблица дропа
 * в браузере превращает «посмотреть, что выпало» в «гриндить известный
 * список».
 *
 * КОЭФФИЦИЕНТЫ И БАЗЫ ПРИХОДЯТ АРГУМЕНТОМ, а не импортом — то же
 * правило, что у `resolveBattle`: пакет не читает `balance.json`
 * и не знает про `packages/data`.
 *
 * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ БОЯ. В бою число бросков за удар обязано
 * зависеть только от ветки, иначе два билда, отличающиеся одним
 * коэффициентом, расходятся ПОТОКОМ, и матрица меряет смещение выборки
 * вместо силы правки. У лута такого сравнения нет и быть не может:
 * правка весов выпадения обязана менять то, что выпадает. Поэтому
 * здесь броски тратятся по надобности, и это осознанная разница,
 * а не забытое правило.
 */

export type GeneratedItem = {
  readonly baseKey: string;
  readonly slot: EquipmentSlot;
  readonly ilvl: number;
  readonly rarity: Rarity;
  readonly affixes: readonly ItemAffix[];
  /**
   * Уникальный модификатор легендарки. ВСЕГДА null в M3a.
   *
   * GDD §6.2: легендарка «меняет правило, а не число». Такие модификаторы —
   * трейт-подобные хуки, и место им рядом с системой трейтов, а не здесь.
   * Поле объявлено сейчас, чтобы форма предмета не менялась, когда они
   * появятся: добавить значение в существующее поле дешевле, чем менять
   * формат уже выданных предметов.
   */
  readonly uniqueModifier: null;
};

export type GenerateItemInput = {
  readonly ilvl: number;
  /** Если не задан — выбирается броском среди слотов, у которых есть базы. */
  readonly slot?: EquipmentSlot;
  /** Если не задана — выбирается броском по весам. */
  readonly rarity?: Rarity;
};

const TIERS: readonly AffixTier[] = ['T1', 'T2', 'T3', 'T4', 'T5'];

/**
 * Взвешенный выбор. Возвращает первый элемент при нулевой сумме весов —
 * это не «случайно так вышло», а решение: набор с нулевыми весами
 * означает ошибку данных, и падать посреди генерации предмета игрока
 * хуже, чем выдать предсказуемый элемент. Ноль у ОДНОГО варианта при
 * ненулевой сумме работает как исключение из выборки — так выключена
 * легендарка в M3a.
 */
function weighted<T extends string>(
  rng: Rng,
  weights: Readonly<Partial<Record<T, number>>>,
  keys: readonly T[],
): T {
  let total = 0;
  for (const key of keys) total += weights[key] ?? 0;

  const first = keys[0];
  if (first === undefined) throw new Error('взвешенный выбор из пустого набора');
  if (total <= 0) return first;

  let roll = rng.next() * total;
  for (const key of keys) {
    roll -= weights[key] ?? 0;
    if (roll < 0) return key;
  }
  return first;
}

/** Тиры, разрешённые уровнем предмета. Пустым быть не может: T5 с ilvl 1. */
export function allowedTiers(ilvl: number, balance: LootBalance): readonly AffixTier[] {
  return TIERS.filter((tier) => ilvl >= balance.affixTierMinIlvl[tier]);
}

function rollAffix(rng: Rng, ilvl: number, balance: LootBalance): ItemAffix {
  const family = weighted<AffixFamily>(rng, balance.drop.familyWeights, ['might', 'strength']);
  const tier = weighted<AffixTier>(rng, balance.drop.tierWeights, allowedTiers(ilvl, balance));

  const [min, max] = balance.affixFamilies[family][tier];
  const raw = min + rng.next() * (max - min);

  // «Сила» — плоские единицы ATK, дробных не бывает. «Мощь» — доля урона,
  // округляется до сотых процента: показывать игроку +12.3457% значит
  // показывать шум вместо числа.
  const value = family === 'strength' ? Math.round(raw) : Math.round(raw * 10_000) / 10_000;

  return { family, tier, value };
}

/**
 * Один предмет из сида. Один сид и один вход — один и тот же предмет.
 *
 * Дубли аффиксов РАЗРЕШЕНЫ и неизбежны: семейств два, а у эпика пять
 * аффиксов. Именно поэтому «Мощь» ограничена бюджетом в бою, а не
 * при генерации, — см. `effectiveStats`.
 */
export function generateItem(
  seed: string,
  input: GenerateItemInput,
  balance: LootBalance,
  bases: readonly ItemBase[],
): GeneratedItem {
  const rng = rngFromSeed(seed);
  const ilvl = Math.max(1, Math.floor(input.ilvl));

  const pool = bases.filter(
    (base) => base.minIlvl <= ilvl && (input.slot === undefined || base.slot === input.slot),
  );
  if (pool.length === 0) {
    throw new Error(
      `нет ни одной базы для ilvl ${ilvl}${input.slot === undefined ? '' : ` и слота «${input.slot}»`}`,
    );
  }

  const base = pool[rng.int(0, pool.length - 1)];
  if (base === undefined) throw new Error('выбор базы вышел за границы пула');

  const rarity =
    input.rarity ??
    weighted<Rarity>(rng, balance.drop.rarityWeights, [
      'common',
      'magic',
      'rare',
      'epic',
      'legendary',
    ]);

  const range = balance.affixCountByRarity[rarity];
  if (range === undefined) throw new Error(`нет числа аффиксов для редкости «${rarity}»`);
  const [minCount, maxCount] = range;
  const count = rng.int(minCount, maxCount);

  const affixes: ItemAffix[] = [];
  for (let i = 0; i < count; i++) affixes.push(rollAffix(rng, ilvl, balance));

  return {
    baseKey: base.key,
    slot: base.slot,
    ilvl,
    rarity,
    affixes,
    uniqueModifier: null,
  };
}
