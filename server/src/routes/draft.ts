import { API_ROUTES, draftPickInputSchema, type DraftResponse } from '@extramundum/shared';
import { Hono, type Context } from 'hono';

import { requireSession } from '../auth/session.ts';
import type { Database } from '../db/client.ts';
import { AppError } from '../http/errors.ts';
import { parseBody, type AppEnv } from '../http/middleware.ts';
import { findPlayerByUserId } from '../players/repository.ts';
import { draftSeedOf } from '../progression/repository.ts';
import { draftContext, draftView, pickDraft, progressView } from '../progression/service.ts';

/**
 * Драфт уровня. GDD §5.2.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: уровня в запросе, состава оффера в запросе и вообще
 * какого-либо состояния игрока в теле. Уровень берётся из базы, оффер
 * пересчитывается сервером из сида, и присланный выбор сверяется с ним.
 * Карты, которой не предлагали, сервер не найдёт — не потому, что
 * интерфейс её не показал, а потому, что её нет в пересчитанном оффере.
 */
export function draftRoutes(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const profileOf = async (c: Context<AppEnv>) => {
    const sessionUser = await requireSession(c);
    const profile = await findPlayerByUserId(db, sessionUser.id);
    if (profile === null) {
      throw new AppError('not_found', {
        messageKey: 'error.not_found',
        message: 'профиль не найден',
      });
    }
    // Идентификатор УЧЁТНОЙ ЗАПИСИ возвращается вместе с профилем: после
    // выбора профиль надо перечитать, а читается он по нему, а не
    // по идентификатору игрока.
    return { profile, userId: sessionUser.id };
  };

  /** GET /draft — что предлагается сейчас, или пустой оффер. */
  app.get(API_ROUTES.draft, async (c) => {
    const { profile } = await profileOf(c);
    const seed = await draftSeedOf(db, profile.id);
    const ctx = await draftContext(db, profile, seed);

    const body: DraftResponse = { draft: draftView(ctx), progress: progressView(profile) };
    return c.json(body);
  });

  /**
   * POST /draft/pick — применить выбор.
   *
   * Возвращает СЛЕДУЮЩИЙ оффер, а не «ок»: уровней могло накопиться
   * несколько, и разбирают их по одному по порядку — выбор за третий
   * уровень обязан влиять на колоду четвёртого.
   */
  app.post(API_ROUTES.draftPick, async (c) => {
    const { profile, userId } = await profileOf(c);
    const input = await parseBody(c, draftPickInputSchema);
    const seed = await draftSeedOf(db, profile.id);

    const draft = await pickDraft(db, profile, seed, input.choice);

    // Профиль перечитывается: уровень и HP изменились той же транзакцией,
    // и полоса опыта обязана показывать состояние ПОСЛЕ выбора.
    const updated = await findPlayerByUserId(db, userId);
    const body: DraftResponse = {
      draft,
      progress: progressView(updated ?? profile),
    };
    return c.json(body);
  });

  return app;
}
