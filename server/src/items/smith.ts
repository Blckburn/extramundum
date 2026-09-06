import { balance as balanceData, itemBase } from '@extramundum/data';
import {
  addMaterials,
  lootBalanceSchema,
  MATERIAL_KEYS,
  rarityUpCost,
  reforgeCost,
  respecCost,
  seededRoll,
  upgradeCost,
  type Item,
  type ItemAffix,
  type Materials,
  type Rarity,
  type SmithCost,
  type SmithOffer,
} from '@extramundum/shared';
import { rollOneAffix } from '@extramundum/sim';
import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../db/client.ts';
import { players } from '../db/schema/game.ts';
import { items, playerCards, playerTraits } from '../db/schema/items.ts';
import { AppError } from '../http/errors.ts';

import { readMaterials, spendMaterials } from './materials.ts';
import { economy } from './prices.ts';
import { toItem } from './repository.ts';

/**
 * Кузнец: улучшение, перековка, повышение редкости, респек. GDD §6.3, §5.2.
 *
 * ГЛАВНЫЙ СТОК ЗОЛОТА. В v1.0 его роль исполнял перекат суффиксов,
 * и после тысячи золота деньги было некуда девать.
 *
 * ПОДДЕЛКА ЗАКРЫТА ДЕТЕРМИНИЗМОМ ПЛЮС СЕРВЕРНЫМ СИДОМ, и нужны обе
 * половины:
 *
 *   — детерминизм не даёт ПЕРЕИГРАТЬ: бросок выводится из счётчика
 *     попыток, а счётчик растёт той же транзакцией, что списывает
 *     цену. Повторный запрос считает уже другой бросок;
 *   — серверный сид не даёт ПОДСМОТРЕТЬ: номер предмета и счётчик
 *     видны клиенту, а `seededRoll` живёт в `shared` и попадает
 *     в браузер. Без секрета игрок посчитал бы исход следующей попытки
 *     сам и жал бы только на удачные — то есть риска из §6.3
 *     не осталось бы вовсе.
 *
 * ЦЕНА ЛИСТАЕТСЯ ИЗ `shared`, а не считается здесь: те же формулы зовёт
 * прибор экономики, и вторая реализация выверяла бы расход, которого
 * игрок не несёт.
 */

const loot = lootBalanceSchema.parse(balanceData.items);
const upgradeBalance = balanceData.items.upgrade;

/** Порядок повышения редкости. Эпик и легендарка не поднимаются (§6.3). */
const RARITY_UP: Readonly<Partial<Record<Rarity, Rarity>>> = {
  common: 'magic',
  magic: 'rare',
  rare: 'epic',
};

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Хватает ли запаса на набор материалов. */
function hasMaterials(have: Materials, need: Materials): boolean {
  for (const key of MATERIAL_KEYS) {
    if ((have[key] ?? 0) < (need[key] ?? 0)) return false;
  }
  return true;
}

function cost(gold: number, materials: Materials, purse: Purse): SmithCost {
  return {
    gold,
    materials,
    affordable: purse.gold >= gold && hasMaterials(purse.materials, materials),
  };
}

export type Purse = { readonly gold: number; readonly materials: Materials };

/* ────────────────────────────── предложения ──────────────────────────── */

/**
 * Что кузнец может сделать с предметом, с ценами и рисками.
 *
 * СЧИТАЕТ СЕРВЕР И ОТДАЁТ ГОТОВЫМ. «Сколько будет стоить» и «какой
 * шанс» — первое, что игрок хочет знать до нажатия, а формулы
 * и коэффициенты у сервера.
 */
export function offerFor(item: Item, purse: Purse, view: SmithOffer['item']): SmithOffer {
  const next = item.upgradeLevel + 1;
  const upgrade =
    next > upgradeBalance.maxLevel
      ? null
      : (() => {
          const c = upgradeCost(next, item.ilvl, economy, upgradeBalance.riskFreeThrough);
          const materials = addMaterials(
            { [c.tier]: c.scrap },
            c.ember > 0 ? { ember: c.ember } : {},
          );
          return { ...cost(c.gold, materials, purse), to: next, success: c.success };
        })();

  const reforge =
    item.affixes.length === 0
      ? null
      : (() => {
          const c = reforgeCost(item.ilvl, economy);
          return cost(c.gold, { [c.tier]: c.scrap }, purse);
        })();

  const up = rarityUpCost(item.rarity, item.ilvl, economy);
  const target = RARITY_UP[item.rarity];
  const rarityUp =
    up === null || target === undefined
      ? null
      : { ...cost(up.gold, { [up.tier]: up.scrap }, purse), to: target };

  return { item: view, upgrade, reforge, rarityUp };
}

export function respecOffer(
  level: number,
  picks: number,
  purse: Purse,
): SmithCost & {
  picks: number;
} {
  return { ...cost(respecCost(level, economy), {}, purse), picks };
}

/* ──────────────────────────────── оплата ─────────────────────────────── */

/**
 * Списать цену и увеличить счётчик попыток ОДНОЙ транзакцией.
 *
 * Золото уходит УСЛОВНЫМ обновлением (`gold >= сколько`), материалы —
 * тем же приёмом внутри `spendMaterials`. Проверка «до» здесь была бы
 * бесполезна: два одновременных запроса прошли бы её оба, а условие
 * в самом UPDATE находит строку один раз.
 *
 * Возвращает номер попытки, ИЗ КОТОРОГО считается бросок. Отдаётся
 * значение ДО инкремента, потому что бросок принадлежит этой попытке,
 * а не следующей.
 */
async function charge(
  tx: Tx,
  playerId: string,
  itemId: string,
  price: { gold: number; materials: Materials },
): Promise<number> {
  const [row] = await tx
    .update(players)
    .set({ gold: sql`${players.gold} - ${price.gold}` })
    .where(and(eq(players.id, playerId), sql`${players.gold} >= ${price.gold}`))
    .returning({ gold: players.gold });

  if (row === undefined) {
    throw new AppError('conflict', {
      messageKey: 'error.smith.noGold',
      message: 'не хватает золота',
    });
  }

  if (!(await spendMaterials(tx, playerId, price.materials))) {
    throw new AppError('conflict', {
      messageKey: 'error.smith.noMaterials',
      message: 'не хватает материалов',
    });
  }

  const [bumped] = await tx
    .update(items)
    .set({ smithAttempts: sql`${items.smithAttempts} + 1` })
    .where(eq(items.id, itemId))
    .returning({ attempts: items.smithAttempts });

  if (bumped === undefined) throw new Error('предмет исчез посреди работы кузнеца');
  // Вернулось значение ПОСЛЕ инкремента — бросок принадлежит попытке,
  // которая только что оплачена, то есть предыдущему номеру.
  return bumped.attempts - 1;
}

/** Предмет игрока внутри транзакции. Чужой и несуществующий — одинаково. */
async function ownedRow(tx: Tx, playerId: string, itemId: string) {
  const rows = await tx
    .select()
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.ownerId, playerId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new AppError('not_found', {
      messageKey: 'error.not_found',
      message: 'предмет не найден',
    });
  }
  return row;
}

async function smithSeedOf(tx: Tx, playerId: string): Promise<string> {
  const rows = await tx
    .select({ seed: players.smithSeed })
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1);
  const seed = rows[0]?.seed;
  if (seed === undefined) throw new Error('профиль не найден');
  return seed;
}

/* ────────────────────────────── улучшение ────────────────────────────── */

export type SmithResult = { item: Item; gold: number; materials: Materials };

/**
 * Попытка поднять предмет на уровень. GDD §6.3.
 *
 * Выше `riskFreeThrough` при провале теряется ОДИН УРОВЕНЬ, предмет
 * не ломается. Уничтожение предмета документ не разрешает, и это
 * важнее, чем кажется: необратимая потеря вещи, в которую вложено
 * золото и лом, превращает сток в наказание, а сток должен быть
 * решением.
 */
export async function upgradeItem(
  db: Database,
  playerId: string,
  itemId: string,
): Promise<SmithResult & { succeeded: boolean }> {
  return db.transaction(async (tx) => {
    const row = await ownedRow(tx, playerId, itemId);
    const item = toItem(row);
    const to = item.upgradeLevel + 1;

    if (to > upgradeBalance.maxLevel) {
      throw new AppError('conflict', {
        messageKey: 'error.smith.maxUpgrade',
        message: 'предмет уже на потолке улучшения',
      });
    }

    const price = upgradeCost(to, item.ilvl, economy, upgradeBalance.riskFreeThrough);
    const materials = addMaterials(
      { [price.tier]: price.scrap },
      price.ember > 0 ? { ember: price.ember } : {},
    );
    const attempt = await charge(tx, playerId, itemId, { gold: price.gold, materials });

    /* Сид СЕРВЕРНЫЙ и в ответ не попадает. Без него игрок посчитал бы
       этот же бросок у себя: номер предмета и счётчик он видит,
       а `seededRoll` лежит в браузерном бандле. */
    const seed = await smithSeedOf(tx, playerId);
    const succeeded = seededRoll(`${seed}:upgrade:${itemId}:${String(attempt)}`) < price.success;

    const level = succeeded ? to : Math.max(0, item.upgradeLevel - 1);
    const [updated] = await tx
      .update(items)
      .set({ upgradeLevel: level })
      .where(eq(items.id, itemId))
      .returning();
    if (updated === undefined) throw new Error('предмет исчез посреди улучшения');

    return {
      succeeded,
      item: toItem(updated),
      ...(await purseOf(tx, playerId)),
    };
  });
}

/* ────────────────────────────── перековка ────────────────────────────── */

/**
 * Перековать ОДИН аффикс. GDD §6.3.
 *
 * Бросок делает та же функция, что и генерация лута, — иначе
 * перекованный аффикс жил бы по правилам, которых нет ни в одном
 * документе. Семейство может смениться: это ставка, а не недосмотр,
 * иначе перековка сводилась бы к бесплатному подъёму тира.
 */
export async function reforgeAffix(
  db: Database,
  playerId: string,
  itemId: string,
  affixIndex: number,
): Promise<SmithResult> {
  return db.transaction(async (tx) => {
    const row = await ownedRow(tx, playerId, itemId);
    const item = toItem(row);

    if (affixIndex >= item.affixes.length) {
      throw new AppError('conflict', {
        messageKey: 'error.smith.noAffix',
        message: 'у предмета нет такого аффикса',
      });
    }

    const price = reforgeCost(item.ilvl, economy);
    const attempt = await charge(tx, playerId, itemId, {
      gold: price.gold,
      materials: { [price.tier]: price.scrap },
    });

    const seed = await smithSeedOf(tx, playerId);
    const rolled = rollOneAffix(
      `${seed}:reforge:${itemId}:${String(affixIndex)}:${String(attempt)}`,
      item.ilvl,
      itemBase(item.baseKey).slot,
      loot,
    );

    const affixes: ItemAffix[] = [...item.affixes];
    affixes[affixIndex] = rolled;

    const [updated] = await tx
      .update(items)
      .set({ affixes })
      .where(eq(items.id, itemId))
      .returning();
    if (updated === undefined) throw new Error('предмет исчез посреди перековки');

    return { item: toItem(updated), ...(await purseOf(tx, playerId)) };
  });
}

/* ──────────────────────── повышение редкости ─────────────────────────── */

/**
 * Поднять редкость на ступень. GDD §6.3: «много лома».
 *
 * НОВЫХ АФФИКСОВ РОВНО СТОЛЬКО, СКОЛЬКО НУЖНО, ЧТОБЫ ДОБРАТЬ
 * ДО МИНИМУМА новой редкости, но не меньше одного. Иначе поднятый
 * до эпика редкий с пятью аффиксами не получил бы ничего, и «много
 * лома» покупало бы одну лишь надпись.
 *
 * Верхнего максимума это не превышает: добор идёт до минимума, а он
 * по построению не больше максимума.
 */
export async function raiseRarity(
  db: Database,
  playerId: string,
  itemId: string,
): Promise<SmithResult> {
  return db.transaction(async (tx) => {
    const row = await ownedRow(tx, playerId, itemId);
    const item = toItem(row);
    const target = RARITY_UP[item.rarity];
    const price = rarityUpCost(item.rarity, item.ilvl, economy);

    if (target === undefined || price === null) {
      throw new AppError('conflict', {
        messageKey: 'error.smith.maxRarity',
        message: 'эта редкость не поднимается',
      });
    }

    const attempt = await charge(tx, playerId, itemId, {
      gold: price.gold,
      materials: { [price.tier]: price.scrap },
    });

    const range = loot.affixCountByRarity[target];
    if (range === undefined) throw new Error(`нет числа аффиксов для редкости «${target}»`);
    const want = Math.max(item.affixes.length + 1, range[0]);

    const seed = await smithSeedOf(tx, playerId);
    const slot = itemBase(item.baseKey).slot;
    const affixes: ItemAffix[] = [...item.affixes];
    for (let i = affixes.length; i < want; i++) {
      affixes.push(
        rollOneAffix(
          `${seed}:rarity:${itemId}:${String(attempt)}:${String(i)}`,
          item.ilvl,
          slot,
          loot,
        ),
      );
    }

    const [updated] = await tx
      .update(items)
      .set({ rarity: target, affixes })
      .where(eq(items.id, itemId))
      .returning();
    if (updated === undefined) throw new Error('предмет исчез посреди работы');

    return { item: toItem(updated), ...(await purseOf(tx, playerId)) };
  });
}

/* ─────────────────────────────── респек ──────────────────────────────── */

/**
 * Сброс выбранных карт и трейтов. GDD §5.2: `200 × уровень`.
 *
 * УДАЛЕНИЕ СТРОК, А НЕ ОБРАТНАЯ АРИФМЕТИКА. Хранятся именно ВЫБОРЫ,
 * и это решение принималось ровно ради этого дня: из суммы прибавок
 * наклон было бы не восстановить, а вычитать её обратно значило бы
 * завести второй способ считать то же самое.
 *
 * Уровень возвращается к первому ТОЙ ЖЕ транзакцией. Он поднимается
 * только вместе с выбором, поэтому «сколько драфтов ждёт» выводится
 * из опыта и числа выборов — и после сброса все драфты ждут снова,
 * без отдельного счётчика.
 */
export async function respecPlayer(
  db: Database,
  playerId: string,
  level: number,
): Promise<{ gold: number }> {
  const price = respecCost(level, economy);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(players)
      .set({ gold: sql`${players.gold} - ${price}`, level: 1 })
      .where(and(eq(players.id, playerId), sql`${players.gold} >= ${price}`))
      .returning({ gold: players.gold });

    if (row === undefined) {
      throw new AppError('conflict', {
        messageKey: 'error.smith.noGold',
        message: 'не хватает золота',
      });
    }

    await tx.delete(playerCards).where(eq(playerCards.playerId, playerId));
    await tx.delete(playerTraits).where(eq(playerTraits.playerId, playerId));

    return { gold: row.gold };
  });
}

/* ──────────────────────────────── кошелёк ────────────────────────────── */

export async function purseOf(db: Database | Tx, playerId: string): Promise<Purse> {
  const rows = await db
    .select({ gold: players.gold })
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1);
  const gold = rows[0]?.gold;
  if (gold === undefined) throw new Error('профиль не найден');
  return { gold, materials: await readMaterials(db as Database, playerId) };
}
