import {
  API_ROUTES,
  battleStartInputSchema,
  simulatePreviewInputSchema,
  type BattleStartResponse,
  type SimulatePreviewResponse,
} from '@extramundum/shared';
import { Hono } from 'hono';

import { estimateWinRate } from '../battle/preview.ts';
import { runBattle } from '../battle/run.ts';
import type { Database } from '../db/client.ts';
import { AppError } from '../http/errors.ts';
import { parseBody, type AppEnv } from '../http/middleware.ts';
import { findPlayerByUserId } from '../players/repository.ts';
import { requireSession } from '../auth/session.ts';

/**
 * Боевые эндпоинты. GDD §3.2, §6.4.
 *
 * Оба обработчика намеренно НЕ принимают состояние игрока из тела
 * запроса: идентификатор берётся из проверенной сессии, профиль
 * читается из БД (инвариант 1, GDD §3.2 шаг 1). Схемы запросов таких
 * полей не содержат вовсе — подменить статы нечем.
 */
export function battleRoutes(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * POST /battle/start — провести бой. GDD §3.2.
   *
   * В теле запроса нет ни одного числа о бойце, и схема таких полей
   * не содержит: состав читается из БД по проверенной сессии. Сид
   * генерируется здесь же. Клиент узнаёт исход уже записанным.
   *
   * НАГРАД НЕТ. Шаг 5 документа требует применить HP, XP, золото и лут
   * в одной транзакции, но прогрессия — это M3. Бой помечается
   * `provisional` и в ответе, и в базе.
   */
  app.post(API_ROUTES.battleStart, async (c) => {
    const sessionUser = await requireSession(c);
    const input = await parseBody(c, battleStartInputSchema);

    const profile = await findPlayerByUserId(db, sessionUser.id);
    if (profile === null) {
      throw new AppError('not_found', {
        messageKey: 'error.not_found',
        message: 'профиль не найден',
      });
    }

    const battle = await runBattle(db, {
      profile,
      zone: input.zone,
      difficulty: input.difficulty,
    });

    c.get('log').info('бой проведён', {
      battleId: battle.battleId,
      zone: input.zone,
      difficulty: input.difficulty,
      events: battle.log.events.length,
      provisional: battle.provisional,
    });

    const body: BattleStartResponse = {
      battleId: battle.battleId,
      log: battle.log,
      outcome: battle.outcome,
      maxHp: battle.maxHp,
      rewards: {},
      provisional: battle.provisional,
    };
    return c.json(body);
  });

  /**
   * POST /simulate/preview — оценка шанса победы. GDD §6.4.
   *
   * Инвариант 1 в чистом виде: в теле запроса нет НИ ОДНОГО поля,
   * описывающего бойца. Идентификатор берётся из сессии, профиль
   * читается из БД. Подменить статы, чтобы получить красивое число,
   * нечем — и это важнее, чем кажется для «безобидного» превью:
   * ровно из таких исключений в v1.0 выросла дыра.
   *
   * Ничего не пишет и наград не выдаёт.
   */
  app.post(API_ROUTES.simulatePreview, async (c) => {
    const sessionUser = await requireSession(c);
    const input = await parseBody(c, simulatePreviewInputSchema);

    const profile = await findPlayerByUserId(db, sessionUser.id);
    if (profile === null) {
      throw new AppError('not_found', {
        messageKey: 'error.not_found',
        message: 'профиль не найден',
      });
    }

    const started = performance.now();
    const { winRate, runs } = estimateWinRate({
      profile,
      zone: input.zone,
      difficulty: input.difficulty,
      runs: input.runs,
    });
    const durationMs = Math.round(performance.now() - started);

    // Бюджет ответа для этого эндпоинта — p95 < 500 мс (GDD §6.4).
    // Логируем длительность, чтобы выход за бюджет был виден в проде,
    // а не выяснялся по жалобам.
    c.get('log').info('simulate/preview', {
      zone: input.zone,
      difficulty: input.difficulty,
      runs,
      winRate: Math.round(winRate * 1000) / 1000,
      durationMs,
    });

    const body: SimulatePreviewResponse = { winRate, runs, basis: 'sparring-dummy' };
    return c.json(body);
  });

  return app;
}
