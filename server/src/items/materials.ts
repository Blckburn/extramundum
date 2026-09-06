import {
  dismantleYield,
  MATERIAL_KEYS,
  type Item,
  type MaterialKey,
  type Materials,
} from '@extramundum/shared';
import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../db/client.ts';
import { playerMaterials } from '../db/schema/items.ts';

import { economy } from './prices.ts';

/**
 * Материалы игрока: лом по тирам и высокий материал. GDD §6.3.
 *
 * ЧТО ДАЁТ РАЗБОР, СЧИТАЕТ `shared`, а не этот файл: ту же функцию
 * зовёт прибор экономики, и вторая реализация разошлась бы молча —
 * калибровка выверяла бы выход, которого игрок не получает.
 *
 * ПРИБАВКА И СПИСАНИЕ — ОДНИМ УСЛОВНЫМ ОБНОВЛЕНИЕМ. Разбор во время
 * открытого экрана кузнеца — обычное дело, и «прочитать, посчитать,
 * записать» потеряло бы одну из двух правок. Списание сверх наличия
 * падает на проверке БД, а не оставляет минус.
 */

export async function readMaterials(db: Database, playerId: string): Promise<Materials> {
  const rows = await db
    .select({ material: playerMaterials.material, amount: playerMaterials.amount })
    .from(playerMaterials)
    .where(eq(playerMaterials.playerId, playerId));

  const out: Partial<Record<MaterialKey, number>> = {};
  for (const row of rows) out[row.material] = row.amount;
  return out;
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Прибавить материалы. Вызывается ВНУТРИ транзакции разбора или боя:
 * материал и то, за что он получен, обязаны появляться вместе.
 */
export async function grantMaterials(tx: Tx, playerId: string, add: Materials): Promise<void> {
  for (const key of MATERIAL_KEYS) {
    const amount = add[key];
    if (amount === undefined || amount === 0) continue;
    await tx
      .insert(playerMaterials)
      .values({ playerId, material: key, amount })
      .onConflictDoUpdate({
        target: [playerMaterials.playerId, playerMaterials.material],
        set: { amount: sql`${playerMaterials.amount} + ${amount}` },
      });
  }
}

/**
 * Списать материалы. Возвращает `false`, если не хватило ХОТЯ БЫ
 * ОДНОГО, не тронув при этом ничего.
 *
 * Условие стоит В САМОМ UPDATE (`amount >= сколько`), а не в проверке
 * до него: два одновременных списания прошли бы проверку «до» оба,
 * а условие в обновлении находит строку только один раз. Это то же
 * правило, что у двойного начисления за бой.
 */
export async function spendMaterials(tx: Tx, playerId: string, cost: Materials): Promise<boolean> {
  for (const key of MATERIAL_KEYS) {
    const amount = cost[key];
    if (amount === undefined || amount === 0) continue;
    const changed = await tx
      .update(playerMaterials)
      .set({ amount: sql`${playerMaterials.amount} - ${amount}` })
      .where(
        and(
          eq(playerMaterials.playerId, playerId),
          eq(playerMaterials.material, key),
          sql`${playerMaterials.amount} >= ${amount}`,
        ),
      )
      .returning({ material: playerMaterials.material });
    if (changed.length === 0) return false;
  }
  return true;
}

/** Что даст разбор предмета. Считает `shared`, здесь только подстановка. */
export function scrapFor(item: Pick<Item, 'ilvl' | 'rarity'>): Materials {
  const yielded = dismantleYield(item, economy);
  return { [yielded.tier]: yielded.amount };
}
