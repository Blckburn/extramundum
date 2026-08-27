import { balance as balanceData } from '@extramundum/data';
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
  /* СТАРТОВЫЕ СТАТЫ БЕРУТСЯ ИЗ balance.archetypes, а не из умолчаний
     схемы. Умолчания 5/5/5/5 — заглушка эпохи M0, когда архетипов ещё
     не было; монстры зон выверены против статов архетипов (9–16),
     и с пятёрками игрок проигрывает первый же бой Пустошей. Замерено
     в M3b, а не предположено.

     ВЫБОРА причины изгнания здесь нет: §5.1 требует выбирать её при
     создании персонажа, но экрана создания не существует — это отдельная
     работа. Поэтому берётся `forbidden`: самый ровный набор из четырёх,
     он никого не ставит в матчапе §4.3 в выигрышное положение заранее. */
  const start = balanceData.archetypes.forbidden;

  const inserted = await db
    .insert(players)
    .values({
      userId: input.userId,
      username: input.username,
      statAtk: start.atk,
      statDef: start.def,
      statAgi: start.agi,
      statSpd: start.spd,
      /* БРОНЯ И ТОЧНОСТЬ АРХЕТИПА — оттуда же, откуда четыре стата.
         До этой правки они не применялись нигде: их читала только
         матрица винрейтов, а живой игрок выходил за стену с нулевой
         бронёй. Оба следствия замерены (см. схему `players`). */
      baseArmor: start.armor,
      baseAccuracy: start.accuracy,
      // Максимум HP считает движок по §4.2; здесь та же формула была бы
      // вторым её местом. Профиль создаётся с запасом, который движок
      // всё равно зажмёт максимумом при входе в бой.
      hpCurrent:
        balanceData.maxHp.base + start.def * balanceData.maxHp.perDef + balanceData.maxHp.perLevel,
    })
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

export function toProfile(row: typeof players.$inferSelect): PlayerProfile {
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
    baseArmor: row.baseArmor,
    baseAccuracy: row.baseAccuracy,
    hpCurrent: row.hpCurrent,
    elo: row.elo,
    seasonId: row.seasonId,
    exileNumber: row.exileNumber,
  };
}
