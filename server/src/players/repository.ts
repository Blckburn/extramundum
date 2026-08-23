import type { PlayerProfile } from '@extramundum/shared';
import { eq, sql } from 'drizzle-orm';

import type { Database } from '../db/client.ts';
import { players } from '../db/schema/game.ts';

/**
 * Доступ к игровым профилям.
 *
 * Все функции здесь принимают userId из ПРОВЕРЕННОЙ СЕССИИ, а не из тела
 * запроса. Это и есть механическая реализация инварианта 1: у обработчика
 * просто нет способа сказать «дай мне профиль вот этого игрока».
 */

/**
 * Создаёт профиль, если его ещё нет. Идемпотентно.
 *
 * Вызывается из хука создания пользователя и повторно из GET /me —
 * второй вызов страхует от разрыва между созданием учётной записи
 * и созданием профиля.
 */
export async function ensurePlayer(
  db: Database,
  input: { userId: string; username: string },
): Promise<{ created: boolean; player: PlayerProfile | null }> {
  const inserted = await db
    .insert(players)
    .values({ userId: input.userId, username: input.username })
    .onConflictDoNothing({ target: players.userId })
    .returning();

  // Возвращает СОЗДАННУЮ строку, а не факт вызова: набор разработки
  // выдаётся один раз, а `ensurePlayer` зовётся и при регистрации,
  // и лениво из GET /me. Без этого различия повторный вход удваивал бы
  // инвентарь.
  const row = inserted[0];
  return row === undefined
    ? { created: false, player: null }
    : { created: true, player: toProfile(row) };
}

export async function findPlayerByUserId(
  db: Database,
  userId: string,
): Promise<PlayerProfile | null> {
  const rows = await db.select().from(players).where(eq(players.userId, userId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toProfile(row);
}

/** Свободно ли имя. Регистр не учитывается — так же, как в уникальном индексе. */
export async function isUsernameTaken(db: Database, username: string): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(players)
    .where(sql`lower(${players.username}) = lower(${username})`)
    .limit(1);
  return rows.length > 0;
}

function toProfile(row: typeof players.$inferSelect): PlayerProfile {
  return {
    id: row.id,
    username: row.username,
    createdAt: row.createdAt.toISOString(),
    level: row.level,
    xp: row.xp,
    paragonPoints: row.paragonPoints,
    gold: row.gold,
    statAtk: row.statAtk,
    statDef: row.statDef,
    statAgi: row.statAgi,
    statSpd: row.statSpd,
    hpCurrent: row.hpCurrent,
    elo: row.elo,
    seasonId: row.seasonId,
    exileNumber: row.exileNumber,
  };
}
