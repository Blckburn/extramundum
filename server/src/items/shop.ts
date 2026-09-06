import { balance as balanceData, ITEM_BASES } from '@extramundum/data';
import { ZONES } from '@extramundum/data/zones';
import {
  buyPrice,
  clearedLevel,
  lootBalanceSchema,
  shopSlotSeed,
  stashTabPrice,
  type Item,
} from '@extramundum/shared';
import { generateItem } from '@extramundum/sim';
import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../db/client.ts';
import { players } from '../db/schema/game.ts';
import { items } from '../db/schema/items.ts';
import { dailies, shopPurchases } from '../db/schema/runs.ts';
import { AppError } from '../http/errors.ts';
import { readZoneProgress } from '../runs/repository.ts';

import { economy } from './prices.ts';

/**
 * Лавка. GDD §6.3.
 *
 * СТОК НИГДЕ НЕ ХРАНИТСЯ, как и оффер драфта: и состав, и цены
 * выводятся из серверного сида дня и номера слота, поэтому сервер
 * считает их заново и при показе, и при покупке. Предмета, которого
 * он не выставлял, сервер не найдёт — не потому, что интерфейс его
 * не показал.
 *
 * АССОРТИМЕНТ ПО САМОМУ ГЛУБОКОМУ ПРОЙДЕННОМУ УЧАСТКУ, А НЕ ПО УРОВНЮ
 * ИГРОКА. Правило одно на всю игру: сила и уровень добычи идут от того,
 * куда ты добрался, а не от того, сколько у тебя опыта. Лавка по уровню
 * вернула бы уровень игрока через чёрный ход — нафармил опыта
 * на низком участке и купил снаряжение, до которого не дошёл. Уровень
 * игрока остаётся статами и картами драфта.
 *
 * ДЕНЬ СЕРВЕРНЫЙ. В v1.0 сток зависел от `new Date()` в браузере:
 * перевёл часы — получил новый ассортимент (§13, пункт 12).
 */

const loot = lootBalanceSchema.parse(balanceData.items);

/** Сегодняшняя дата СЕРВЕРА, YYYY-MM-DD. */
export function serverDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Строка дневных счётчиков за сегодня, создавая её при надобности.
 *
 * `onConflictDoNothing` плюс перечитывание, а не «прочитать, потом
 * вставить»: два одновременных запроса прошли бы проверку «нет строки»
 * оба, и второй упал бы на уникальном индексе.
 */
export async function shopSeedFor(db: Database, playerId: string, day: string): Promise<string> {
  await db
    .insert(dailies)
    .values({ playerId, dayUtc: day, shopSeed: crypto.randomUUID() })
    .onConflictDoNothing({ target: [dailies.playerId, dailies.dayUtc] });

  const rows = await db
    .select({ seed: dailies.shopSeed })
    .from(dailies)
    .where(and(eq(dailies.playerId, playerId), eq(dailies.dayUtc, day)))
    .limit(1);

  const seed = rows[0]?.seed;
  if (seed === undefined) throw new Error('дневная строка не создалась');
  return seed;
}

/**
 * Предмет в слоте — ИЗ СИДА, а не из таблицы.
 *
 * Одна функция на показ и на покупку: вторая реализация выставила бы
 * в витрине одно, а продала бы другое, и разошлись бы они молча.
 */
export function slotItem(shopSeed: string, slot: number, level: number): Item {
  const generated = generateItem(shopSlotSeed(shopSeed, slot), { ilvl: level }, loot, ITEM_BASES);
  return {
    /* Номер выдаётся только при покупке: пока предмет на витрине,
       его в таблице предметов нет вовсе. Здесь стоит подпись слота,
       а НЕ сид с номером: сид серверный, и подставить его в поле,
       которое уезжает клиенту, значило бы отдать его даром. Поймано
       тестом «сид лавки не уходит клиенту», а не глазами. */
    id: `shop-slot-${String(slot)}`,
    baseKey: generated.baseKey,
    slot: generated.slot,
    ilvl: generated.ilvl,
    rarity: generated.rarity,
    affixes: [...generated.affixes],
    upgradeLevel: 0,
    locked: false,
    container: 'inv',
  };
}

/** Цена покупки. Выведена из цены продажи наценкой строго больше единицы. */
export function slotPrice(item: Item): number {
  return buyPrice(item, { ...loot.sell, ilvlScale: loot.ilvlScale }, economy);
}

export type ShopState = {
  readonly seed: string;
  readonly day: string;
  readonly level: number;
  readonly gold: number;
  readonly sold: ReadonlySet<number>;
};

export async function shopState(db: Database, playerId: string): Promise<ShopState> {
  const day = serverDay();
  const [seed, progress, purchases, rows] = await Promise.all([
    shopSeedFor(db, playerId, day),
    readZoneProgress(db, playerId),
    db
      .select({ slot: shopPurchases.slot })
      .from(shopPurchases)
      .where(and(eq(shopPurchases.playerId, playerId), eq(shopPurchases.dayUtc, day))),
    db.select({ gold: players.gold }).from(players).where(eq(players.id, playerId)).limit(1),
  ]);

  const gold = rows[0]?.gold;
  if (gold === undefined) throw new Error('профиль не найден');

  return {
    seed,
    day,
    level: clearedLevel(ZONES, progress),
    gold,
    sold: new Set(purchases.map((row) => row.slot)),
  };
}

/**
 * Купить слот. GDD §6.3.
 *
 * ОДНОЙ ТРАНЗАКЦИЕЙ: отметка о покупке, списание золота и появление
 * предмета. Отметка идёт ПЕРВОЙ и на уникальном индексе — два
 * одновременных запроса дают одну строку, второй падает на нём
 * и откатывается целиком. Проверка «куплено ли» до вставки прошла бы
 * у обоих: это то же правило, что у двойного начисления за бой.
 */
export async function buySlot(
  db: Database,
  playerId: string,
  slot: number,
): Promise<{ gold: number; item: Item }> {
  if (slot < 0 || slot >= economy.shop.slots) {
    throw new AppError('not_found', {
      messageKey: 'error.shop.noSlot',
      message: 'такого слота на витрине нет',
    });
  }

  const state = await shopState(db, playerId);
  const item = slotItem(state.seed, slot, state.level);
  const price = slotPrice(item);

  return db.transaction(async (tx) => {
    const claimed = await tx
      .insert(shopPurchases)
      .values({ playerId, dayUtc: state.day, slot })
      .onConflictDoNothing({
        target: [shopPurchases.playerId, shopPurchases.dayUtc, shopPurchases.slot],
      })
      .returning({ slot: shopPurchases.slot });

    if (claimed.length === 0) {
      throw new AppError('conflict', {
        messageKey: 'error.shop.sold',
        message: 'этот товар уже куплен сегодня',
      });
    }

    const [row] = await tx
      .update(players)
      .set({ gold: sql`${players.gold} - ${price}` })
      .where(and(eq(players.id, playerId), sql`${players.gold} >= ${price}`))
      .returning({ gold: players.gold });

    if (row === undefined) {
      throw new AppError('conflict', {
        messageKey: 'error.shop.noGold',
        message: 'не хватает золота',
      });
    }

    const [inserted] = await tx
      .insert(items)
      .values({
        ownerId: playerId,
        baseKey: item.baseKey,
        ilvl: item.ilvl,
        rarity: item.rarity,
        affixes: item.affixes,
        container: 'inv',
      })
      .returning({ id: items.id });

    if (inserted === undefined) throw new Error('предмет не создался');

    return { gold: row.gold, item: { ...item, id: inserted.id } };
  });
}

/**
 * Купить следующую вкладку стеша. GDD §6.3.
 *
 * НОМЕР ВКЛАДКИ НЕ ПРИНИМАЕТСЯ: он выводится из числа уже купленных.
 * Иначе можно было бы купить четвёртую, не купив третью, — то есть
 * по цене третьей.
 *
 * Цена и счётчик двигаются ОДНОЙ транзакцией и с условием
 * `stash_tabs = ожидаемый`: два одновременных запроса иначе купили бы
 * две вкладки по цене одной. То же правило, что у двойного начисления
 * за бой.
 */
export async function buyStashTab(
  db: Database,
  playerId: string,
): Promise<{ gold: number; owned: number }> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select({ tabs: players.stashTabs })
      .from(players)
      .where(eq(players.id, playerId))
      .limit(1);

    const owned = current[0]?.tabs;
    if (owned === undefined) throw new Error('профиль не найден');

    const price = stashTabPrice(owned, economy);
    if (price === null) {
      throw new AppError('conflict', {
        messageKey: 'error.shop.allTabs',
        message: 'все вкладки уже куплены',
      });
    }

    const [row] = await tx
      .update(players)
      .set({ gold: sql`${players.gold} - ${price}`, stashTabs: owned + 1 })
      .where(
        and(
          eq(players.id, playerId),
          eq(players.stashTabs, owned),
          sql`${players.gold} >= ${price}`,
        ),
      )
      .returning({ gold: players.gold, tabs: players.stashTabs });

    if (row === undefined) {
      throw new AppError('conflict', {
        messageKey: 'error.shop.noGold',
        message: 'не хватает золота',
      });
    }

    return { gold: row.gold, owned: row.tabs };
  });
}
