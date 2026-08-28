import { and, eq } from 'drizzle-orm';

import type { Database } from '../db/client.ts';
import { players } from '../db/schema/game.ts';
import { playerCards, playerTraits } from '../db/schema/items.ts';

/**
 * Доступ к выбранному в драфте. GDD §5.2.
 *
 * Как и у забега, каждое изменение идёт УСЛОВНОЙ вставкой: уникальность
 * по (игрок, уровень) стоит в базе, поэтому два одновременных выбора
 * за один уровень не могут пройти оба, даже если проверка «до» пропустит
 * обоих.
 */

/**
 * Сид драфта игрока.
 *
 * Читается ОТДЕЛЬНО от профиля и в публичный профиль не входит: по нему
 * считаются будущие офферы, и знать их клиенту незачем — иначе игрок
 * видел бы карты сорокового уровня на первом.
 */
export async function draftSeedOf(db: Database, playerId: string): Promise<string> {
  const rows = await db
    .select({ seed: players.draftSeed })
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new Error('профиль не найден при чтении сида драфта');
  return row.seed;
}

export type CardPick = { readonly level: number; readonly cardId: string };
export type TraitPick = { readonly slot: number; readonly traitId: string };

export async function cardPicksOf(db: Database, playerId: string): Promise<CardPick[]> {
  const rows = await db
    .select({ level: playerCards.level, cardId: playerCards.cardId })
    .from(playerCards)
    .where(eq(playerCards.playerId, playerId));
  return rows.sort((a, b) => a.level - b.level);
}

export async function traitPicksOf(db: Database, playerId: string): Promise<TraitPick[]> {
  const rows = await db
    .select({ slot: playerTraits.slot, traitId: playerTraits.traitId })
    .from(playerTraits)
    .where(eq(playerTraits.playerId, playerId));
  return rows.sort((a, b) => a.slot - b.slot);
}

/**
 * Записать выбор карты и поднять уровень ОДНОЙ транзакцией.
 *
 * Уровень двигается здесь же, а не отдельным запросом: между двумя
 * запросами игрок успел бы уйти в рейд с картой, но без уровня — или
 * наоборот. Условие `level = ожидаемый` в UPDATE не даёт применить
 * выбор дважды: второй запрос не найдёт строку.
 */
export async function applyCardPick(
  db: Database,
  input: {
    playerId: string;
    level: number;
    cardId: string;
    expectedLevel: number;
    hpCurrent: number;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(playerCards).values({
      playerId: input.playerId,
      level: input.level,
      cardId: input.cardId,
    });

    const [row] = await tx
      .update(players)
      .set({ level: input.level, hpCurrent: input.hpCurrent })
      .where(and(eq(players.id, input.playerId), eq(players.level, input.expectedLevel)))
      .returning({ id: players.id });

    if (row === undefined) throw new Error('уровень изменился между чтением и записью');
  });
}

/**
 * Записать выбор трейта и поднять уровень. То же правило, что у карты.
 *
 * Номер слота — порядковый: он нужен уникальному индексу в схеме
 * и порядку показа, а не механике. Механика знает трейт по идентификатору.
 */
export async function applyTraitPick(
  db: Database,
  input: {
    playerId: string;
    level: number;
    traitId: string;
    slot: number;
    expectedLevel: number;
    hpCurrent: number;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(playerTraits).values({
      playerId: input.playerId,
      traitId: input.traitId,
      slot: input.slot,
    });

    const [row] = await tx
      .update(players)
      .set({ level: input.level, hpCurrent: input.hpCurrent })
      .where(and(eq(players.id, input.playerId), eq(players.level, input.expectedLevel)))
      .returning({ id: players.id });

    if (row === undefined) throw new Error('уровень изменился между чтением и записью');
  });
}
