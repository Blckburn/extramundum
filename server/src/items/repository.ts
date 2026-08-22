import { balance as balanceData, itemBase } from '@extramundum/data';
import {
  itemAffixSchema,
  lootBalanceSchema,
  type Container,
  type EquipmentSlot,
  type Item,
  type ItemAffix,
  type Rarity,
} from '@extramundum/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../db/client.ts';
import { players } from '../db/schema/game.ts';
import { equipment, items } from '../db/schema/items.ts';
import { AppError } from '../http/errors.ts';

import type { Loadout } from './loadout.ts';

/**
 * Доступ к предметам.
 *
 * Каждая функция принимает `playerId`, полученный ИЗ ПРОВЕРЕННОЙ СЕССИИ,
 * и every запрос фильтрует по владельцу. У обработчика нет способа
 * сказать «возьми вот этот предмет» без проверки, чей он: это и есть
 * механическая реализация инварианта 1.
 */

const loot = lootBalanceSchema.parse(balanceData.items);

/** Строка БД → предмет контракта. Аффиксы валидируются, а не приводятся. */
function toItem(row: typeof items.$inferSelect): Item {
  const base = itemBase(row.baseKey);
  return {
    id: row.id,
    baseKey: row.baseKey,
    slot: base.slot,
    ilvl: row.ilvl,
    rarity: row.rarity,
    // jsonb приходит как unknown: разбираем схемой. Пропустить разбор
    // значило бы доверять содержимому колонки, а колонка переживает
    // все правки формата аффиксов.
    affixes: itemAffixSchema.array().parse(row.affixes),
    upgradeLevel: row.upgradeLevel,
    locked: row.locked,
    container: row.container,
  };
}

export async function listItems(db: Database, playerId: string): Promise<readonly Item[]> {
  const rows = await db.select().from(items).where(eq(items.ownerId, playerId));
  return rows.map(toItem);
}

export async function equippedMap(
  db: Database,
  playerId: string,
): Promise<ReadonlyMap<EquipmentSlot, string>> {
  const rows = await db.select().from(equipment).where(eq(equipment.playerId, playerId));
  return new Map(rows.map((row) => [row.slot, row.itemId]));
}

/** Надетое как набор предметов — то, из чего собирается боец. */
export async function loadoutOf(db: Database, playerId: string): Promise<Loadout> {
  const [all, equipped] = await Promise.all([listItems(db, playerId), equippedMap(db, playerId)]);
  const byId = new Map(all.map((item) => [item.id, item]));

  const loadout = new Map<EquipmentSlot, Item>();
  for (const [slot, itemId] of equipped) {
    const item = byId.get(itemId);
    if (item !== undefined) loadout.set(slot, item);
  }
  return loadout;
}

async function ownedItem(db: Database, playerId: string, itemId: string): Promise<Item> {
  const rows = await db
    .select()
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.ownerId, playerId)))
    .limit(1);
  const row = rows[0];
  // Чужой предмет и несуществующий дают ОДИН И ТОТ ЖЕ ответ: иначе
  // 404 против 403 превращается в способ узнать, существует ли чужой
  // предмет с таким идентификатором.
  if (row === undefined) {
    throw new AppError('not_found', {
      messageKey: 'error.not_found',
      message: 'предмет не найден',
    });
  }
  return toItem(row);
}

/** Предмет по владельцу — для гипотетического набора в превью. */
export async function equipItemView(db: Database, playerId: string, itemId: string): Promise<Item> {
  return ownedItem(db, playerId, itemId);
}

async function countIn(db: Database, playerId: string, container: Container): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(items)
    .where(and(eq(items.ownerId, playerId), eq(items.container, container)));
  return rows[0]?.n ?? 0;
}

/**
 * Надеть. Слот выводится ИЗ БАЗЫ предмета, а не приходит от клиента:
 * иначе кольцо оказалось бы в слоте оружия.
 */
export async function equipItem(db: Database, playerId: string, itemId: string): Promise<void> {
  const item = await ownedItem(db, playerId, itemId);
  if (item.container === 'equipped') return;

  await db.transaction(async (tx) => {
    // Слот занят — прежний предмет возвращается в инвентарь. Уникальный
    // индекс по (player, slot) не дал бы просто вставить второй.
    const current = await tx
      .select()
      .from(equipment)
      .where(and(eq(equipment.playerId, playerId), eq(equipment.slot, item.slot)))
      .limit(1);

    const previous = current[0];
    if (previous !== undefined) {
      await tx.update(items).set({ container: 'inv' }).where(eq(items.id, previous.itemId));
      await tx
        .delete(equipment)
        .where(and(eq(equipment.playerId, playerId), eq(equipment.slot, item.slot)));
    }

    await tx.insert(equipment).values({ playerId, slot: item.slot, itemId: item.id });
    await tx.update(items).set({ container: 'equipped' }).where(eq(items.id, item.id));
  });
}

export async function unequipSlot(
  db: Database,
  playerId: string,
  slot: EquipmentSlot,
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(equipment)
      .where(and(eq(equipment.playerId, playerId), eq(equipment.slot, slot)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return;

    await tx
      .delete(equipment)
      .where(and(eq(equipment.playerId, playerId), eq(equipment.slot, slot)));
    await tx.update(items).set({ container: 'inv' }).where(eq(items.id, row.itemId));
  });
}

export async function moveItem(
  db: Database,
  playerId: string,
  itemId: string,
  to: 'inv' | 'stash',
): Promise<void> {
  const item = await ownedItem(db, playerId, itemId);
  if (item.container === 'equipped') {
    throw new AppError('conflict', {
      messageKey: 'error.item.equipped',
      message: 'надетый предмет нельзя переместить, сначала снимите его',
    });
  }
  if (item.container === to) return;

  const capacity = to === 'inv' ? loot.capacity.inv : loot.capacity.stash;
  if ((await countIn(db, playerId, to)) >= capacity) {
    throw new AppError('conflict', {
      messageKey: 'error.item.containerFull',
      message: 'нет места',
    });
  }

  await db.update(items).set({ container: to }).where(eq(items.id, itemId));
}

export async function setLocked(
  db: Database,
  playerId: string,
  itemId: string,
  locked: boolean,
): Promise<void> {
  await ownedItem(db, playerId, itemId);
  await db.update(items).set({ locked }).where(eq(items.id, itemId));
}

/** Провизорная цена. Настоящая — M3c вместе с экономикой (§6.3). */
export function sellPrice(item: Item): number {
  const multiplier = loot.sell.rarityMultiplier[item.rarity] ?? 1;
  return Math.floor(loot.sell.base * multiplier * (1 + item.ilvl * loot.ilvlScale));
}

/**
 * Массовая продажа по фильтру редкости. GDD §6.3.
 *
 * ЗАБЛОКИРОВАННЫЕ НЕ ПРОДАЮТСЯ НИКОГДА, даже попав под фильтр: замок
 * существует ровно для этого. Надетое тоже не продаётся — оно не лежит
 * ни в инвентаре, ни в стеше.
 *
 * Всё одной транзакцией: списание предметов и начисление золота
 * не должны расходиться, даже если между ними что-то упадёт.
 */
export async function sellByRarity(
  db: Database,
  playerId: string,
  rarities: readonly Rarity[],
  from: 'inv' | 'stash',
): Promise<{ sold: number; gold: number }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(items)
      .where(
        and(
          eq(items.ownerId, playerId),
          eq(items.container, from),
          eq(items.locked, false),
          inArray(items.rarity, [...rarities]),
        ),
      );

    if (rows.length === 0) return { sold: 0, gold: 0 };

    const gold = rows.reduce((sum, row) => sum + sellPrice(toItem(row)), 0);
    await tx.delete(items).where(
      inArray(
        items.id,
        rows.map((row) => row.id),
      ),
    );
    await tx
      .update(players)
      .set({ gold: sql`${players.gold} + ${gold}` })
      .where(eq(players.id, playerId));

    return { sold: rows.length, gold };
  });
}

export type NewItem = {
  readonly baseKey: string;
  readonly ilvl: number;
  readonly rarity: Rarity;
  readonly affixes: readonly ItemAffix[];
  readonly container: 'inv' | 'stash';
};

/** Положить предметы игроку. Единственный путь появления предметов. */
export async function grantItems(
  db: Database,
  playerId: string,
  granted: readonly NewItem[],
): Promise<void> {
  if (granted.length === 0) return;
  await db.insert(items).values(
    granted.map((item) => ({
      ownerId: playerId,
      baseKey: item.baseKey,
      ilvl: item.ilvl,
      rarity: item.rarity,
      affixes: item.affixes,
      container: item.container,
    })),
  );
}
