import { z } from 'zod';

import { armorClassSchema, weaponClassSchema } from './combat.js';

/**
 * Контракт предметов. GDD §5.3 (слоты), §6.1 (ilvl и аффиксы),
 * §6.2 (редкость).
 *
 * Здесь только формы и перечисления. Числа — в `balance.json`
 * (инвариант 5), базы предметов — в `packages/data/items/*.json`,
 * как риги и палитра.
 */

/* ──────────────────────────────── слоты ──────────────────────────────── */

/**
 * Восемь слотов. GDD §5.3.
 *
 * Список ОДИН на весь репозиторий. До M3a копий было три: перечисление
 * БД, `ICON_ENTITIES.slot` и локальный массив в экране деревни. Копия
 * рано или поздно расходится с оригиналом молча — на этом уже ловились
 * с архетипами (см. шапку `packages/data/assets.ts`).
 */
export const EQUIPMENT_SLOTS = [
  'weapon',
  'offhand',
  'helmet',
  'chest',
  'bracers',
  'boots',
  'amulet',
  'ring',
] as const;
export const equipmentSlotSchema = z.enum(EQUIPMENT_SLOTS);
export type EquipmentSlot = z.infer<typeof equipmentSlotSchema>;

/**
 * Оффхенд — три РАЗНЫХ типа, а не три варианта одного (GDD §5.3).
 *
 * `shield` даёт блок, `weapon` даёт урон и блока не даёт вовсе,
 * `focus` усиливает наложенные носителем статусы. Это три стиля игры
 * на одном слоте, и именно поэтому тип входит в предмет, а не выводится
 * из наличия полей.
 */
export const OFFHAND_KINDS = ['shield', 'weapon', 'focus'] as const;
export const offhandKindSchema = z.enum(OFFHAND_KINDS);
export type OffhandKind = z.infer<typeof offhandKindSchema>;

/* ─────────────────────────────── редкость ────────────────────────────── */

/** GDD §6.2. Порядок — от худшего к лучшему, на него опирается сортировка. */
export const RARITIES = ['common', 'magic', 'rare', 'epic', 'legendary'] as const;
export const raritySchema = z.enum(RARITIES);
export type Rarity = z.infer<typeof raritySchema>;

/** Где лежит предмет. Совпадает с перечислением БД. */
export const CONTAINERS = ['inv', 'stash', 'equipped'] as const;
export const containerSchema = z.enum(CONTAINERS);
export type Container = z.infer<typeof containerSchema>;

/* ──────────────────────────────── аффиксы ────────────────────────────── */

/**
 * Тиры. GDD §6.1. Порядок — от лучшего к худшему, как в документе.
 */
export const AFFIX_TIERS = ['T1', 'T2', 'T3', 'T4', 'T5'] as const;
export const affixTierSchema = z.enum(AFFIX_TIERS);
export type AffixTier = z.infer<typeof affixTierSchema>;

/**
 * Семейства аффиксов. СЕМЬ: два атакующих и пять защитных.
 *
 * Два первых перенесены из GDD §6.1 дословно и выверены замером в M1c.
 * Пять защитных пришли в M3b решением человека: до них кольцо, амулет
 * и наручи отличались друг от друга только наличием брони, то есть
 * слоты из §5.3 существовали, а ролей у них не было.
 *
 * | Семейство   | Что даёт            | Форма   | Слоты                         |
 * | ----------- | ------------------- | ------- | ----------------------------- |
 * | `might`     | урон                | процент | оружие, оффхенд, наручи, амулет, кольцо |
 * | `strength`  | ATK                 | плоское | там же                        |
 * | `fortitude` | броня               | плоское | шлем, нагрудник, наручи, сапоги |
 * | `bastion`   | броня               | процент | шлем, нагрудник               |
 * | `vitality`  | максимум HP         | плоское | нагрудник, амулет, кольцо     |
 * | `swiftness` | SPD                 | процент | сапоги, кольцо                |
 * | `truehand`  | точность            | плоское | наручи, кольцо, амулет        |
 *
 * ПОЧЕМУ ПРОЦЕНТ ОТ БРОНИ, А НЕ ПРОЦЕНТ СНИЖЕНИЯ УРОНА. Прямое снижение
 * перемножается в неуязвимость: четыре аффикса по −15% дают −48%, и это
 * не упирается ни во что. Броня же проходит через `ARM/(ARM+40+12×lvl)`
 * и самоограничивается — та же прибавка тем слабее, чем больше брони
 * уже есть.
 *
 * ПОЧЕМУ ПРОЦЕНТ ЗДЕСЬ ВООБЩЕ ДОПУСТИМ, хотя §6.1 против процентов
 * от стата. Возражение документа в том, что процент от ATK проходит
 * через `1 + ATK/60` и даёт РАЗНОЕ на разных персонажах при одинаковой
 * надписи. У брони это насыщение — то, ради чего её и выбрали вместо
 * прямого снижения. У SPD преобразование линейное (инициатива копится
 * ровно по SPD за тик), поэтому процент честен, а плоское было бы
 * наоборот перекошено: при базовом SPD 9–15 «+1» это от 7% до 11%.
 */
export const AFFIX_FAMILIES = [
  'might',
  'strength',
  'fortitude',
  'bastion',
  'vitality',
  'swiftness',
  'truehand',
] as const;
export const affixFamilySchema = z.enum(AFFIX_FAMILIES);
export type AffixFamily = z.infer<typeof affixFamilySchema>;

/**
 * Семейства, работающие МНОЖИТЕЛЕМ, а не слагаемым.
 *
 * Отдельный список, потому что от формы зависит всё остальное: плоские
 * складываются в один стат и бюджета не требуют, процентные
 * перемножаются и потому могут его требовать. Бюджет держит движок
 * (`familyMultiplier`), и он же читает этот список.
 */
export const PERCENT_AFFIX_FAMILIES = ['might', 'bastion', 'swiftness'] as const;
export type PercentAffixFamily = (typeof PERCENT_AFFIX_FAMILIES)[number];

/** Плоские семейства: складываются в стат носителя, потолка счёта нет. */
export const FLAT_AFFIX_FAMILIES = ['strength', 'fortitude', 'vitality', 'truehand'] as const;
export type FlatAffixFamily = (typeof FLAT_AFFIX_FAMILIES)[number];

export function isPercentFamily(family: AffixFamily): family is PercentAffixFamily {
  return (PERCENT_AFFIX_FAMILIES as readonly string[]).includes(family);
}

export const itemAffixSchema = z.object({
  family: affixFamilySchema,
  tier: affixTierSchema,
  /**
   * Скатанное значение. Для «Мощи» — доля урона (0.12 = +12%), для
   * «Силы» — плоские единицы ATK.
   *
   * Хранится ЧИСЛОМ, а не ссылкой на тир: перекатывать диапазоны тира
   * задним числом (M3c) нельзя, не изменив уже выданные предметы.
   */
  value: z.number(),
});
export type ItemAffix = z.infer<typeof itemAffixSchema>;

/* ───────────────────────────── база предмета ─────────────────────────── */

/**
 * База предмета — то, что лежит в `packages/data/items/*.json`.
 *
 * Числа здесь БАЗОВЫЕ, до масштабирования по ilvl. Масштаб считает
 * `baseValue()` по формуле GDD §6.1, и он один на весь репозиторий.
 */
export const itemBaseSchema = z.object({
  /** Совпадает с ключом иконки в assets.json и с `items.base_key` в БД. */
  key: z.string().min(1),
  slot: equipmentSlotSchema,
  /** Минимальный ilvl, с которого база вообще выпадает. */
  minIlvl: z.int().min(1).default(1),

  /* оружие */
  dmgMin: z.number().min(0).optional(),
  dmgMax: z.number().min(0).optional(),
  weaponClass: weaponClassSchema.optional(),

  /* броня */
  armor: z.number().min(0).optional(),
  armorClass: armorClassSchema.optional(),

  /* оффхенд */
  offhandKind: offhandKindSchema.optional(),
  blockChance: z.number().min(0).max(1).optional(),
  blockReduction: z.number().min(0).max(1).optional(),
  /** Множитель силы своих статусов. Только у фокуса. */
  statusPower: z.number().min(1).optional(),
});
export type ItemBase = z.infer<typeof itemBaseSchema>;

/* ──────────────────────────── предмет целиком ────────────────────────── */

export const itemSchema = z.object({
  id: z.uuid(),
  baseKey: z.string().min(1),
  slot: equipmentSlotSchema,
  ilvl: z.int().min(1).max(200),
  rarity: raritySchema,
  affixes: z.array(itemAffixSchema),
  upgradeLevel: z.int().min(0).max(10),
  locked: z.boolean(),
  container: containerSchema,
});
export type Item = z.infer<typeof itemSchema>;

/**
 * Базовое значение с учётом ilvl. GDD §6.1:
 *
 *     базовое_значение = база × (1 + ilvl × 0.04)
 *
 * Одна функция на весь репозиторий — и сервер, и генератор, и тултип
 * считают одинаково. Вторая такая формула повторила бы пункт 2 аудита
 * v1.0, где максимум HP выводился в двух местах и разошёлся.
 */
export function baseValue(base: number, ilvl: number, ilvlScale: number): number {
  return base * (1 + ilvl * ilvlScale);
}

/* ─────────────────────── запросы и ответы инвентаря ──────────────────── */

/**
 * Во всех запросах ниже клиент присылает ТОЛЬКО идентификаторы.
 * Ни одного числа о предмете, ни одной характеристики: состав и сила
 * читаются сервером из БД (инвариант 1). Подменить нечем — схема
 * таких полей не содержит.
 */

export const equipInputSchema = z.object({ itemId: z.uuid() });
export type EquipInput = z.infer<typeof equipInputSchema>;

export const unequipInputSchema = z.object({ slot: equipmentSlotSchema });
export type UnequipInput = z.infer<typeof unequipInputSchema>;

/** Перемещение между инвентарём и стешем. `equipped` сюда не входит. */
export const moveInputSchema = z.object({
  itemId: z.uuid(),
  to: z.enum(['inv', 'stash']),
});
export type MoveInput = z.infer<typeof moveInputSchema>;

export const lockInputSchema = z.object({ itemId: z.uuid(), locked: z.boolean() });
export type LockInput = z.infer<typeof lockInputSchema>;

/**
 * Массовая продажа с фильтром по редкости. GDD §6.3.
 *
 * Редкости — СПИСОК, а не диапазон: «всё до редкого включительно»
 * и «обычные и эпические» — разные намерения, и второе выразить
 * диапазоном нельзя.
 *
 * Заблокированные не продаются никогда, даже если попали под фильтр:
 * замок существует ровно для этого (§6.3).
 */
export const sellInputSchema = z.object({
  rarities: z.array(raritySchema).min(1),
  from: z.enum(['inv', 'stash']),
});
export type SellInput = z.infer<typeof sellInputSchema>;

export type SellResponse = {
  readonly sold: number;
  readonly gold: number;
};

/**
 * Числа предмета ПОСЛЕ масштабирования по ilvl. Считает сервер.
 *
 * Клиент их не выводит и не может: формула одна и живёт в `baseValue`,
 * а показывать игроку «база 8–14» там, где в бою участвует 9–16, —
 * это пункт 4 аудита v1.0 в чистом виде.
 */
export type ItemDerived = {
  readonly dmgMin?: number;
  readonly dmgMax?: number;
  readonly armor?: number;
  readonly blockChance?: number;
  readonly blockReduction?: number;
  readonly statusPower?: number;
};

export type ItemAffixView = ItemAffix & {
  /**
   * Учитывается ли аффикс в бою. Заполняется ТОЛЬКО у надетых предметов
   * и только у семейств С БЮДЖЕТОМ: считаются N сильнейших на персонажа,
   * остальные не дают ничего (GDD §6.1 для «Мощи», замер M3b
   * для остальных процентных).
   *
   * Считает сервер, потому что ответ зависит от всего надетого набора.
   * Клиент это рисует, а не выводит.
   */
  readonly counted?: boolean;
};

export type ItemView = Omit<Item, 'affixes'> & {
  readonly affixes: readonly ItemAffixView[];
  readonly derived: ItemDerived;
  readonly offhandKind?: OffhandKind;
  readonly weaponClass?: string;
  readonly armorClass?: string;
};

/**
 * Производные характеристики бойца от НАДЕТОГО. Их сравнивает превью.
 *
 * Считает сервер по тем же правилам, по которым собирает бойца для боя,
 * — иначе превью обещало бы одно, а бой давал другое.
 */
export type LoadoutStats = {
  readonly atk: number;
  /** Броня ПОСЛЕ «Крепости» и «Оплота»: то самое число, что идёт в бой. */
  readonly armor: number;
  readonly dmgMin: number;
  readonly dmgMax: number;
  readonly spd: number;
  readonly accuracy: number;
  readonly maxHp: number;
  readonly mightMultiplier: number;
  readonly bastionMultiplier: number;
  readonly swiftnessMultiplier: number;
  /**
   * Надето и учтено по каждому процентному семейству.
   *
   * Пара чисел, а не одно: «надел три, считаются две» — единственный
   * способ объяснить игроку, почему третий аффикс ничего не дал.
   * Прятать это хуже, чем показать: игрок надел бы третий, не получил
   * ничего и решил бы, что система сломана.
   */
  readonly percentAffixes: Readonly<
    Record<PercentAffixFamily, { readonly worn: number; readonly budget: number }>
  >;
};

/**
 * Числовые поля набора — те, у которых имеет смысл дельта в превью.
 *
 * Список явный, а не `Object.keys`: в `LoadoutStats` есть и составное
 * поле (`percentAffixes`), и вычитать его нечем. Прежний перебор всех
 * ключей работал, пока все они были числами, и сломался бы молча —
 * `NaN` в дельте выглядит как «стало хуже», а не как ошибка.
 */
export const LOADOUT_STAT_KEYS = [
  'atk',
  'armor',
  'dmgMin',
  'dmgMax',
  'spd',
  'accuracy',
  'maxHp',
  'mightMultiplier',
  'bastionMultiplier',
  'swiftnessMultiplier',
] as const satisfies readonly (keyof LoadoutStats)[];
export type LoadoutStatKey = (typeof LOADOUT_STAT_KEYS)[number];

export type InventoryResponse = {
  readonly items: readonly ItemView[];
  /** Слот → идентификатор надетого предмета. Пустые слоты не входят. */
  readonly equipped: Readonly<Partial<Record<EquipmentSlot, string>>>;
  readonly stats: LoadoutStats;
  readonly gold: number;
  /** Вместимость инвентаря и стеша. Вкладки за золото — M3c. */
  readonly capacity: { readonly inv: number; readonly stash: number };
};
