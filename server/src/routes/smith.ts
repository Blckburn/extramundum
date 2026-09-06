import {
  API_ROUTES,
  reforgeInputSchema,
  respecInputSchema,
  smithItemInputSchema,
  type ReforgeResponse,
  type RespecResponse,
  type SmithOffer,
  type SmithViewResponse,
  type UpgradeResponse,
} from '@extramundum/shared';
import { Hono, type Context } from 'hono';

import { requireSession } from '../auth/session.ts';
import type { Database } from '../db/client.ts';
import { AppError } from '../http/errors.ts';
import { parseBody, type AppEnv } from '../http/middleware.ts';
import { toView } from '../items/loadout.ts';
import { listItems } from '../items/repository.ts';
import {
  offerFor,
  purseOf,
  raiseRarity,
  reforgeAffix,
  respecOffer,
  respecPlayer,
  upgradeItem,
} from '../items/smith.ts';
import { findPlayerByUserId } from '../players/repository.ts';
import { cardPicksOf, traitPicksOf } from '../progression/repository.ts';
import { progressView } from '../progression/service.ts';
import { findActiveRun } from '../runs/repository.ts';

/**
 * Кузнец. GDD §6.3, §5.2.
 *
 * НИ ОДНО ТЕЛО НЕ НЕСЁТ ЧИСЛА. Идентификатор предмета и, у перековки,
 * номер аффикса — всё. Цена, шанс и результат считаются сервером
 * из состояния в базе (инвариант 1); прислать «шанс успеха» или
 * «уровень улучшения» нечем, потому что схемы таких полей не содержат.
 */
export function smithRoutes(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const playerOf = async (c: Context<AppEnv>) => {
    const sessionUser = await requireSession(c);
    const profile = await findPlayerByUserId(db, sessionUser.id);
    if (profile === null) {
      throw new AppError('not_found', {
        messageKey: 'error.not_found',
        message: 'профиль не найден',
      });
    }
    return { profile, userId: sessionUser.id };
  };

  /** Что кузнец может сделать со всем, что есть у игрока, — с ценами. */
  app.get(API_ROUTES.smith, async (c) => {
    const { profile } = await playerOf(c);
    const [all, purse, cards, traits] = await Promise.all([
      listItems(db, profile.id),
      purseOf(db, profile.id),
      cardPicksOf(db, profile.id),
      traitPicksOf(db, profile.id),
    ]);

    /* Показ предмета собирается БЕЗ квот бюджета: экран кузнеца
       не про то, что учитывается в бою, а про то, что можно
       переделать. Зачёркивание сверхбюджетных аффиксов живёт
       на экране снаряжения, где оно и отвечает на свой вопрос. */
    const offers: SmithOffer[] = all.map((item) => offerFor(item, purse, toView(item, null)));

    const body: SmithViewResponse = {
      gold: purse.gold,
      materials: purse.materials,
      offers,
      respec: respecOffer(profile.level, cards.length + traits.length, purse),
    };
    return c.json(body);
  });

  app.post(API_ROUTES.smithUpgrade, async (c) => {
    const { profile } = await playerOf(c);
    const input = await parseBody(c, smithItemInputSchema);
    const result = await upgradeItem(db, profile.id, input.itemId);

    c.get('log').info('улучшение предмета', {
      playerId: profile.id,
      itemId: input.itemId,
      succeeded: result.succeeded,
      level: result.item.upgradeLevel,
    });

    const body: UpgradeResponse = {
      succeeded: result.succeeded,
      item: toView(result.item, null),
      gold: result.gold,
      materials: result.materials,
    };
    return c.json(body);
  });

  app.post(API_ROUTES.smithReforge, async (c) => {
    const { profile } = await playerOf(c);
    const input = await parseBody(c, reforgeInputSchema);
    const result = await reforgeAffix(db, profile.id, input.itemId, input.affixIndex);

    const body: ReforgeResponse = {
      item: toView(result.item, null),
      gold: result.gold,
      materials: result.materials,
    };
    return c.json(body);
  });

  app.post(API_ROUTES.smithRarityUp, async (c) => {
    const { profile } = await playerOf(c);
    const input = await parseBody(c, smithItemInputSchema);
    const result = await raiseRarity(db, profile.id, input.itemId);

    const body: ReforgeResponse = {
      item: toView(result.item, null),
      gold: result.gold,
      materials: result.materials,
    };
    return c.json(body);
  });

  /**
   * Респек. GDD §5.2.
   *
   * ВО ВРЕМЯ ЗАБЕГА ЗАПРЕЩЁН, и это не придирка: забег — ставка,
   * сделанная ЭТИМ билдом. Пересобрать билд между третьим и четвёртым
   * боем значило бы менять условия ставки после того, как увидел,
   * что выпало.
   */
  app.post(API_ROUTES.smithRespec, async (c) => {
    const { profile, userId } = await playerOf(c);
    await parseBody(c, respecInputSchema);

    if ((await findActiveRun(db, profile.id)) !== null) {
      throw new AppError('conflict', {
        messageKey: 'error.smith.inRun',
        message: 'нельзя пересобрать билд посреди забега',
      });
    }

    const { gold } = await respecPlayer(db, profile.id, profile.level);

    c.get('log').info('респек', { playerId: profile.id, spent: profile.level });

    // Профиль перечитывается: уровень сброшен той же транзакцией,
    // и полоса опыта обязана показывать состояние ПОСЛЕ сброса.
    const updated = await findPlayerByUserId(db, userId);
    const body: RespecResponse = {
      gold,
      progression: progressView(updated ?? profile),
    };
    return c.json(body);
  });

  return app;
}
