import { z } from 'zod';

import { difficultySchema, type Difficulty } from './battle.js';
import { raritySchema, type AffixTier, type Item, type Rarity } from './items.js';

/**
 * Экономика: цены, материалы, фляги. GDD §6.3, §5.2, §7.2.
 *
 * ВСЕ ФОРМУЛЫ ЖИВУТ ЗДЕСЬ, И ЭТО НЕ УБОРКА. Их зовут двое: сервер,
 * когда списывает золото, и замер, когда считает расход. Вторая
 * реализация разошлась бы с первой молча — и калибровка выверяла бы
 * цены, которых игрок не платит. На этом уже стояли с `sellPrice`,
 * который лежал в `server/src/items/repository.ts`, и прибору его
 * оттуда было не достать.
 *
 * Функции ЧИСТЫЕ и берут коэффициенты аргументом: `shared` не читает
 * `balance.json` сам, как и `sim`.
 */

/* ──────────────────────────── коэффициенты ───────────────────────────── */

const scrapTierSchema = z.enum(['T1', 'T2', 'T3', 'T4', 'T5']);
export type ScrapTier = z.infer<typeof scrapTierSchema>;
export const SCRAP_TIERS: readonly ScrapTier[] = ['T1', 'T2', 'T3', 'T4', 'T5'];

/**
 * Всё, что копится не золотом: лом по тирам плюс высокий материал.
 *
 * `ember` стоит рядом с ломом, а не отдельным полем, потому что тратят
 * их вместе — попытка улучшения выше +5 стоит и того, и другого.
 * Разведи их по двум формам, и цена операции перестала бы быть одним
 * значением, которое можно сложить, показать и проверить.
 */
export type MaterialKey = ScrapTier | 'ember';
export const MATERIAL_KEYS: readonly MaterialKey[] = [...SCRAP_TIERS, 'ember'];

/** Сколько чего есть или сколько чего дано. Отсутствие ключа — ноль. */
export type Materials = Readonly<Partial<Record<MaterialKey, number>>>;

/** Сложить два набора материалов. Отрицательные значения — расход. */
export function addMaterials(a: Materials, b: Materials): Materials {
  const out: Partial<Record<MaterialKey, number>> = { ...a };
  for (const key of MATERIAL_KEYS) {
    const delta = b[key];
    if (delta === undefined) continue;
    out[key] = (out[key] ?? 0) + delta;
  }
  return out;
}

export const economyBalanceSchema = z.object({
  materials: z.object({
    /** Граница тира по ilvl разобранного предмета, по возрастанию. */
    tierByIlvl: z.array(z.object({ tier: scrapTierSchema, maxIlvl: z.int().min(1) })).min(1),
    scrapByRarity: z.record(raritySchema, z.number().min(0)),
    /** Шанс высокого материала за бой, по сложности. */
    emberChanceByDifficulty: z.record(difficultySchema, z.number().min(0).max(1)),
  }),
  smith: z.object({
    upgrade: z.object({
      goldBase: z.number().min(0),
      goldGrowth: z.number().min(1),
      scrapBase: z.number().min(0),
      scrapGrowth: z.number().min(1),
      /** Шанс успеха по целевому уровню, начиная с первого рискового. */
      successAbove: z.record(z.string(), z.number().min(0).max(1)),
      emberAbove: z.number().min(0),
    }),
    reforge: z.object({
      goldBase: z.number().min(0),
      goldPerIlvl: z.number().min(0),
      scrap: z.number().min(0),
    }),
    /**
     * Повышение редкости: обычный → магический → редкий → эпический.
     *
     * КЛЮЧИ ПЕРЕЧИСЛЕНЫ ЯВНО, а не взяты записью по всем редкостям.
     * Эпик и легендарка не поднимаются никуда, и отсутствие записи —
     * это и есть отказ. Запись со всеми ключами потребовала бы
     * поставить им ноль, а ноль читается как «бесплатно», а не как
     * «нельзя»: одна невнимательная строка на сервере превратила бы
     * потолок редкости в его отсутствие.
     */
    rarityUp: z.object({
      scrap: z.object({
        common: z.number().min(0),
        magic: z.number().min(0),
        rare: z.number().min(0),
      }),
      gold: z.object({
        common: z.number().min(0),
        magic: z.number().min(0),
        rare: z.number().min(0),
      }),
    }),
    respecPerLevel: z.number().min(0),
  }),
  shop: z.object({
    slots: z.int().min(1),
    /**
     * Наценка лавки. СТРОГО БОЛЬШЕ ЕДИНИЦЫ, и это замок, а не щедрость:
     * цена покупки обязана превышать цену продажи того же предмета,
     * иначе «купить и продать» становится насосом.
     */
    markup: z.number().gt(1),
  }),
  flasks: z.object({
    tiers: z
      .array(
        z.object({
          id: z.string().min(1),
          /** Доля максимума HP, [мин, макс]. Бросок, а не число (§7.2). */
          restore: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
          price: z.number().min(0),
          side: z
            .object({ good: z.string(), bad: z.string(), chance: z.number().min(0).max(1) })
            .nullable(),
        }),
      )
      .min(1),
    maxCharges: z.int().min(1),
  }),
  stashTabs: z.object({
    prices: z.array(z.number().min(0)).min(1),
    slotsPerTab: z.int().min(1),
  }),
});
export type EconomyBalance = z.infer<typeof economyBalanceSchema>;

/** Коэффициенты цены продажи. Живут в `items` балансa, рядом с лутом. */
export interface SellBalance {
  readonly base: number;
  readonly ilvlScale: number;
  readonly rarityMultiplier: Partial<Record<Rarity, number>>;
  readonly affixTierBonus: Partial<Record<AffixTier, number>>;
}

/* ─────────────────────────────── продажа ─────────────────────────────── */

/**
 * Цена продажи предмета. GDD §6.3.
 *
 *   цена = base × множитель_редкости × (1 + ilvl × ilvlScale) × (1 + качество)
 *
 * УРОВЕНЬ УЛУЧШЕНИЯ В ЦЕНУ НЕ ВХОДИТ, и это решение, а не упущение.
 * Улучшение — вложение в СВОЙ предмет, а не в его перепродажу. Войди
 * оно в цену, «улучшить и продать» стало бы насосом ровно тогда, когда
 * цена улучшения окажется ниже прибавки к цене, — то есть на одном
 * неудачном числе, а не на неудачной конструкции.
 *
 * Аффиксы входят: без них два эпика — один с четырьмя T1, другой
 * с четырьмя T5 — стоили бы одинаково, и читать аффиксы перед массовой
 * продажей было бы незачем.
 */
export function sellPrice(
  item: Pick<Item, 'ilvl' | 'rarity' | 'affixes'>,
  sell: SellBalance,
): number {
  const multiplier = sell.rarityMultiplier[item.rarity] ?? 1;
  let quality = 0;
  for (const affix of item.affixes) quality += sell.affixTierBonus[affix.tier] ?? 0;
  return Math.floor(sell.base * multiplier * (1 + item.ilvl * sell.ilvlScale) * (1 + quality));
}

/**
 * Цена покупки в лавке.
 *
 * ВСЕГДА ВЫШЕ ЦЕНЫ ПРОДАЖИ того же предмета, потому что выведена
 * из неё умножением на наценку строго больше единицы. Замок стоит
 * в схеме, а не в проверке результата: цена не может оказаться ниже
 * при каком-нибудь редком сочетании аффиксов.
 */
export function buyPrice(
  item: Pick<Item, 'ilvl' | 'rarity' | 'affixes'>,
  sell: SellBalance,
  economy: Pick<EconomyBalance, 'shop'>,
): number {
  return Math.ceil(sellPrice(item, sell) * economy.shop.markup);
}

/* ─────────────────────────────── материалы ───────────────────────────── */

/**
 * Тир лома, который даст разбор предмета этого уровня.
 *
 * Границы совпадают с диапазонами зон, и это не совпадение: лом с зоны
 * обязан чинить вещи той же зоны, иначе тир лома и глубина рейда живут
 * по разным линейкам.
 */
export function scrapTierFor(ilvl: number, economy: Pick<EconomyBalance, 'materials'>): ScrapTier {
  for (const step of economy.materials.tierByIlvl) {
    if (ilvl <= step.maxIlvl) return step.tier;
  }
  const last = economy.materials.tierByIlvl[economy.materials.tierByIlvl.length - 1];
  if (last === undefined) throw new Error('в балансе нет ни одного тира лома');
  return last.tier;
}

export interface Scrap {
  readonly tier: ScrapTier;
  readonly amount: number;
}

/**
 * Что даст разбор предмета. GDD §6.3.
 *
 * Тир от УРОВНЯ, количество от РЕДКОСТИ — две оси, как у добычи.
 * Это закрывает дыру, не запрещая её: набив сто эпиков на участке 1-2,
 * игрок получает гору T1, которой нельзя тронуть ничего выше восьмого
 * уровня.
 */
export function dismantleYield(
  item: Pick<Item, 'ilvl' | 'rarity'>,
  economy: Pick<EconomyBalance, 'materials'>,
): Scrap {
  return {
    tier: scrapTierFor(item.ilvl, economy),
    amount: economy.materials.scrapByRarity[item.rarity] ?? 0,
  };
}

/**
 * Шанс высокого материала за ОДИН выигранный бой. GDD §6.3.
 *
 * ЕДИНСТВЕННАЯ ПРИЧИНА ХОДИТЬ НА ВЫСОКИЕ СЛОЖНОСТИ ПОМИМО РЕДКОСТИ.
 * На «нормально» он не падает вовсе, и это ноль в данных, а не ветка
 * в коде: сложность без своей записи означала бы, что про неё забыли.
 *
 * Падает В СУМКУ, как и лут, — то есть теряется при смерти. Начисляй
 * его сразу в запас, и высокая сложность давала бы ресурс без ставки,
 * а решение об эвакуации перестало бы покрывать всё, что забег принёс.
 */
export function emberChanceFor(
  difficulty: Difficulty,
  economy: Pick<EconomyBalance, 'materials'>,
): number {
  return economy.materials.emberChanceByDifficulty[difficulty] ?? 0;
}

/* ──────────────────────────────── кузнец ─────────────────────────────── */

export interface UpgradeCost {
  readonly gold: number;
  readonly scrap: number;
  readonly tier: ScrapTier;
  /** Высокий материал: нужен только выше безрискового потолка. */
  readonly ember: number;
  /** Шанс успеха. Единица — попытка без риска. */
  readonly success: number;
}

/**
 * Цена и риск попытки поднять предмет до уровня `to`. GDD §6.3.
 *
 * Растёт ЭКСПОНЕНТОЙ по документу, а не лестницей руками: лестница
 * из десяти чисел разошлась бы с формулой при первой же правке.
 *
 * Выше `riskFreeThrough` при провале теряется один уровень, предмет
 * не ломается. Здесь возвращается только шанс — что делать с провалом,
 * решает сервер одной транзакцией.
 */
export function upgradeCost(
  to: number,
  ilvl: number,
  economy: Pick<EconomyBalance, 'materials' | 'smith'>,
  riskFreeThrough: number,
): UpgradeCost {
  const u = economy.smith.upgrade;
  const step = Math.max(1, to);
  const risky = to > riskFreeThrough;
  return {
    gold: Math.round(u.goldBase * Math.pow(u.goldGrowth, step - 1)),
    scrap: Math.max(1, Math.round(u.scrapBase * Math.pow(u.scrapGrowth, step - 1))),
    tier: scrapTierFor(ilvl, economy),
    ember: risky ? u.emberAbove : 0,
    success: risky ? (u.successAbove[String(to)] ?? 0) : 1,
  };
}

/** Цена перековки одного аффикса: золото плюс лом. GDD §6.3. */
export function reforgeCost(
  ilvl: number,
  economy: Pick<EconomyBalance, 'materials' | 'smith'>,
): { gold: number; scrap: number; tier: ScrapTier } {
  const r = economy.smith.reforge;
  return {
    gold: Math.round(r.goldBase + r.goldPerIlvl * ilvl),
    scrap: r.scrap,
    tier: scrapTierFor(ilvl, economy),
  };
}

/**
 * Цена повышения редкости. GDD §6.3: «много лома».
 *
 * `from` — редкость СЕЙЧАС. Эпик и выше не поднимаются: записи для них
 * в балансе нет, и это отказ, а не нулевая цена.
 */
export function rarityUpCost(
  from: Rarity,
  ilvl: number,
  economy: Pick<EconomyBalance, 'materials' | 'smith'>,
): { gold: number; scrap: number; tier: ScrapTier } | null {
  if (from !== 'common' && from !== 'magic' && from !== 'rare') return null;
  return {
    gold: economy.smith.rarityUp.gold[from],
    scrap: economy.smith.rarityUp.scrap[from],
    tier: scrapTierFor(ilvl, economy),
  };
}

/** Цена респека. GDD §5.2: `200 × уровень`. */
export function respecCost(level: number, economy: Pick<EconomyBalance, 'smith'>): number {
  return Math.round(economy.smith.respecPerLevel * level);
}

/* ──────────────────────────── фляги и вкладки ────────────────────────── */

/**
 * Сколько восстановит фляга этого тира при данном броске. §7.2.
 *
 * БРОСОК, А НЕ ДОЛЯ, и приходит он аргументом: `shared` не бросает
 * сам, как и `sim`. Игрок видит выпавшее ДО решения об эвакуации,
 * поэтому случайность работает на решение, а не против него.
 */
export function flaskRestore(
  tierId: string,
  roll: number,
  economy: Pick<EconomyBalance, 'flasks'>,
): number {
  const tier = economy.flasks.tiers.find((t) => t.id === tierId);
  if (tier === undefined) throw new Error(`нет тира фляги «${tierId}»`);
  const [lo, hi] = tier.restore;
  return lo + (hi - lo) * Math.max(0, Math.min(1, roll));
}

/** Цена заряда фляги этого тира. */
export function flaskPrice(tierId: string, economy: Pick<EconomyBalance, 'flasks'>): number {
  const tier = economy.flasks.tiers.find((t) => t.id === tierId);
  if (tier === undefined) throw new Error(`нет тира фляги «${tierId}»`);
  return tier.price;
}

/**
 * Цена следующей вкладки стеша. `null` — все куплены.
 *
 * `owned` — сколько куплено сверх стартовой вместимости.
 */
export function stashTabPrice(
  owned: number,
  economy: Pick<EconomyBalance, 'stashTabs'>,
): number | null {
  return economy.stashTabs.prices[owned] ?? null;
}

/* ─────────────────────── что игрок может потратить ───────────────────── */

/**
 * Кошелёк: золото и лом по тирам.
 *
 * Отдельный тип, потому что его считает и сервер, и замер расхода,
 * и обе стороны обязаны складывать одинаково.
 */
export type Purse = {
  readonly gold: number;
  readonly scrap: Readonly<Partial<Record<ScrapTier, number>>>;
  readonly ember: number;
};

export const EMPTY_PURSE: Purse = { gold: 0, scrap: {}, ember: 0 };

/** Сложить два кошелька. Отрицательные значения — расход. */
export function addPurse(a: Purse, b: Purse): Purse {
  const scrap: Partial<Record<ScrapTier, number>> = { ...a.scrap };
  for (const tier of SCRAP_TIERS) {
    const delta = b.scrap[tier];
    if (delta === undefined) continue;
    scrap[tier] = (scrap[tier] ?? 0) + delta;
  }
  return { gold: a.gold + b.gold, scrap, ember: a.ember + b.ember };
}

/** Есть ли чем заплатить. Ноль и меньше по любой позиции — нет. */
export function canAfford(purse: Purse, cost: Purse): boolean {
  if (purse.gold < cost.gold || purse.ember < cost.ember) return false;
  for (const tier of SCRAP_TIERS) {
    if ((purse.scrap[tier] ?? 0) < (cost.scrap[tier] ?? 0)) return false;
  }
  return true;
}

export type { Difficulty };

/* ──────────────────────────────── лавка ──────────────────────────────── */

/**
 * Дневной сток лавки. GDD §6.3.
 *
 * НИГДЕ НЕ ХРАНИТСЯ, как и оффер драфта: и состав, и цены выводятся
 * из серверного сида дня и номера слота, поэтому сервер считает их
 * заново и при показе, и при покупке. Отсюда защита от подделки:
 * предмета, которого он не выставлял, сервер не найдёт — не потому,
 * что интерфейс его не показал.
 *
 * СИД СЕРВЕРНЫЙ И ОТ ДАТЫ СЕРВЕРА. В v1.0 сток зависел от `new Date()`
 * в браузере: перевёл часы — получил новый ассортимент (§13, пункт 12).
 */
export function shopSlotSeed(shopSeed: string, slot: number): string {
  return `${shopSeed}:shop:${String(slot)}`;
}
