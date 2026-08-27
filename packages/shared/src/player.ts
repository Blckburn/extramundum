import { z } from 'zod';

import { usernameSchema } from './auth.js';

/**
 * Публичный профиль игрока — то, что сервер отдаёт клиенту на GET /me.
 *
 * Важно: сервер собирает это, читая строку из БД по сессии. Клиент
 * не присылает ни одного из этих полей и не может на них повлиять
 * (инвариант 1). Список полей — GDD §3.3, таблица players.
 */
export const playerProfileSchema = z.object({
  id: z.uuid(),
  username: usernameSchema,
  createdAt: z.iso.datetime(),

  level: z.int().min(1),
  xp: z.int().min(0),
  paragonPoints: z.int().min(0),
  gold: z.int().min(0),

  statAtk: z.int().min(0),
  statDef: z.int().min(0),
  statAgi: z.int().min(0),
  statSpd: z.int().min(0),

  /**
   * Базовые броня и точность причины изгнания. GDD §5.1.
   *
   * Отдаются клиенту наравне со статами: игрок видит, с чем он вышел
   * за стену. Снаряжение складывается сверху, но НЕ здесь — эти числа
   * остаются базой и от надетого не меняются.
   */
  baseArmor: z.int().min(0),
  baseAccuracy: z.int().min(0),

  hpCurrent: z.int().min(0),
  elo: z.int().min(0),
  seasonId: z.int().min(0).nullable(),

  /**
   * Номер в книге покойников. LORE §2, GDD §1.
   * Выдаётся последовательностью в БД, монотонен, не переиспользуется.
   */
  exileNumber: z.int().min(1),
});

export type PlayerProfile = z.infer<typeof playerProfileSchema>;

/** Ответ GET /me. */
export const meResponseSchema = z.object({
  player: playerProfileSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;
