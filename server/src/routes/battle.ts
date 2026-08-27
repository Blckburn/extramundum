import {
  API_ROUTES,
  LOADOUT_STAT_KEYS,
  battleStartInputSchema,
  equipmentSlotSchema,
  simulatePreviewInputSchema,
  type BattleStartResponse,
  type LoadoutStats,
  type PreviewChange,
  type SimulatePreviewResponse,
} from '@extramundum/shared';
import { Hono } from 'hono';

import { estimateWinRate } from '../battle/preview.ts';
import { runBattle } from '../battle/run.ts';
import type { Database } from '../db/client.ts';
import { AppError } from '../http/errors.ts';
import { parseBody, type AppEnv } from '../http/middleware.ts';
import { loadoutStats, type Loadout } from '../items/loadout.ts';
import { equipItemView, loadoutOf } from '../items/repository.ts';
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

    // Надетое читается ИЗ БАЗЫ по владельцу. Клиент не сообщает
    // ни состава, ни характеристик — и не может: схема запроса
    // таких полей не содержит (инвариант 1, GDD §3.2 шаг 1).
    const loadout = await loadoutOf(db, profile.id);

    const battle = await runBattle(db, {
      profile,
      zone: input.zone,
      difficulty: input.difficulty,
      loadout,
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
    const current = await loadoutOf(db, profile.id);

    /* «Что будет, если надеть» — по ИДЕНТИФИКАТОРУ предмета.
       Клиент присылает id, сервер проверяет владение и собирает набор
       сам. Прислать характеристики нечем: схема таких полей не содержит,
       а предмет читается из БД (инвариант 1). */
    const hypothetical =
      input.change === undefined ? null : await applyChange(db, profile.id, current, input.change);

    const estimate = (loadout: typeof current) =>
      estimateWinRate({
        profile,
        zone: input.zone,
        difficulty: input.difficulty,
        runs: input.runs,
        loadout,
      });

    const base = estimate(current);
    const changed = hypothetical === null ? null : estimate(hypothetical);

    const winRate = changed?.winRate ?? base.winRate;
    const runs = base.runs;
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

    const body: SimulatePreviewResponse = {
      winRate,
      runs,
      basis: base.basis,
      ...(base.against === undefined ? {} : { against: base.against }),
      ...(base.enemyLevel === undefined ? {} : { enemyLevel: base.enemyLevel }),
      ...(hypothetical === null
        ? {}
        : {
            baseWinRate: base.winRate,
            // Дельты считает СЕРВЕР по тем же правилам, по которым
            // собирает бойца для боя: две функции с разными правилами
            // разошлись бы, и превью обещало бы одно, а бой давал другое.
            deltas: statDeltas(loadoutStats(profile, current), loadoutStats(profile, hypothetical)),
          }),
    };
    return c.json(body);
  });

  return app;
}

/**
 * Гипотетический набор: «как если бы надели вот это».
 *
 * Ничего не пишет в базу. Предмет читается по ВЛАДЕЛЬЦУ — чужой
 * не найдётся, и ответ на чужой и на несуществующий одинаков.
 */
async function applyChange(
  db: Database,
  playerId: string,
  current: Loadout,
  change: PreviewChange,
): Promise<Loadout> {
  const next = new Map(current);

  if (change.kind === 'unequip') {
    const slot = equipmentSlotSchema.parse(change.slot);
    next.delete(slot);
    return next;
  }

  const item = await equipItemView(db, playerId, change.itemId);
  next.set(item.slot, item);
  return next;
}

/**
 * Разница производных набора. Только изменившееся.
 *
 * Перебираются ЧИСЛОВЫЕ поля по явному списку, а не все ключи подряд:
 * в наборе есть и составное поле (сколько аффиксов надето и сколько
 * считается), и вычитание дало бы `NaN`, который на экране выглядит
 * как «стало хуже», а не как ошибка.
 */
function statDeltas(before: LoadoutStats, after: LoadoutStats): Record<string, number> {
  const deltas: Record<string, number> = {};
  for (const key of LOADOUT_STAT_KEYS) {
    const diff = after[key] - before[key];
    // Ноль не показывается: строка «ATK +0» не сообщает ничего,
    // а список из восьми нулей прячет то единственное, что изменилось.
    if (Math.abs(diff) > 1e-9) deltas[key] = Math.round(diff * 10_000) / 10_000;
  }
  return deltas;
}
