import { balance as balanceData } from '@extramundum/data';
import {
  API_ROUTES,
  dismantleInputSchema,
  equipInputSchema,
  lockInputSchema,
  lootBalanceSchema,
  moveInputSchema,
  sellInputSchema,
  unequipInputSchema,
  type DismantleResponse,
  type InventoryResponse,
  type SellResponse,
} from '@extramundum/shared';
import { Hono, type Context } from 'hono';

import { requireSession } from '../auth/session.ts';
import type { Database } from '../db/client.ts';
import { AppError } from '../http/errors.ts';
import { parseBody, type AppEnv } from '../http/middleware.ts';
import { countedQuotas, loadoutStats, toView } from '../items/loadout.ts';
import { progressionOf } from '../progression/service.ts';
import { readMaterials } from '../items/materials.ts';
import {
  dismantleItems,
  equipItem,
  equippedMap,
  listItems,
  loadoutOf,
  moveItem,
  sellItems,
  setLocked,
  unequipSlot,
} from '../items/repository.ts';
import { findPlayerByUserId } from '../players/repository.ts';

/**
 * Инвентарь и экипировка. GDD §5.3, §6.3.
 *
 * НИ ОДИН обработчик не принимает характеристик предмета — только
 * идентификаторы, и схемы таких полей не содержат. Предмет читается
 * из БД по владельцу, слот выводится из его базы. Выдать себе предмет
 * или усилить существующий нечем: эндпоинта, принимающего состояние,
 * здесь нет (инвариант 1).
 *
 * Источника предметов среди этих маршрутов тоже нет: лут появляется
 * в рейдах (M3b), а до тех пор — только набором разработки за флагом.
 */
const loot = lootBalanceSchema.parse(balanceData.items);

export function itemRoutes(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * Профиль обслуживаемого игрока. ЕДИНСТВЕННЫЙ вход в данные:
   * идентификатор берётся из проверенной сессии, а не из запроса.
   */
  const playerOf = async (c: Context<AppEnv>) => {
    const sessionUser = await requireSession(c);
    const profile = await findPlayerByUserId(db, sessionUser.id);
    if (profile === null) {
      throw new AppError('not_found', {
        messageKey: 'error.not_found',
        message: 'профиль не найден',
      });
    }
    return profile;
  };

  /** Всё, что есть у игрока, плюс производные набора. */
  app.get(API_ROUTES.items, async (c) => {
    const profile = await playerOf(c);
    const [all, equipped, loadout, progression, materials] = await Promise.all([
      listItems(db, profile.id),
      equippedMap(db, profile.id),
      loadoutOf(db, profile.id),
      progressionOf(db, profile),
      readMaterials(db, profile.id),
    ]);

    const quotas = countedQuotas(loadout);

    const body: InventoryResponse = {
      // Пометка «аффикс учитывается» ставится только надетым: для
      // лежащего в стеше вопрос не имеет смысла, пока он не надет
      // вместе с остальными.
      // Квота считается ОДИН раз на набор и расходуется по мере показа:
      // посчитанная внутри каждого предмета, она никогда не кончалась бы,
      // и сверхбюджетный аффикс не был бы зачёркнут ни у кого.
      items: all.map((item) => toView(item, item.container === 'equipped' ? quotas : null)),
      equipped: Object.fromEntries(equipped),
      stats: loadoutStats(profile, loadout, progression),
      gold: profile.gold,
      materials,
      capacity: loot.capacity,
    };
    return c.json(body);
  });

  app.post(API_ROUTES.itemsEquip, async (c) => {
    const profile = await playerOf(c);
    const input = await parseBody(c, equipInputSchema);
    await equipItem(db, profile.id, input.itemId);
    return c.json({ ok: true } as const);
  });

  app.post(API_ROUTES.itemsUnequip, async (c) => {
    const profile = await playerOf(c);
    const input = await parseBody(c, unequipInputSchema);
    await unequipSlot(db, profile.id, input.slot);
    return c.json({ ok: true } as const);
  });

  app.post(API_ROUTES.itemsMove, async (c) => {
    const profile = await playerOf(c);
    const input = await parseBody(c, moveInputSchema);
    await moveItem(db, profile.id, input.itemId, input.to);
    return c.json({ ok: true } as const);
  });

  app.post(API_ROUTES.itemsLock, async (c) => {
    const profile = await playerOf(c);
    const input = await parseBody(c, lockInputSchema);
    await setLocked(db, profile.id, input.itemId, input.locked);
    return c.json({ ok: true } as const);
  });

  /**
   * Продажа: фильтром по редкости или поимённым списком.
   *
   * Заблокированные не продаются никогда, надетые не попадают
   * в выборку. Список нужен затем, что продажа — половина развилки
   * с разбором, а вторая половина берётся по конкретной вещи.
   */
  app.post(API_ROUTES.itemsSell, async (c) => {
    const profile = await playerOf(c);
    const input = await parseBody(c, sellInputSchema);
    /* Схема уже гарантирует, что задана ровно одна из двух форм: их
       взаимоисключимость проверяется `refine`, а не здесь. */
    const { sold, gold } = await sellItems(
      db,
      profile.id,
      input.itemIds === undefined
        ? { kind: 'rarity', rarities: input.rarities ?? [], from: input.from ?? 'inv' }
        : { kind: 'items', itemIds: input.itemIds },
    );

    c.get('log').info('продажа', {
      playerId: profile.id,
      ...(input.itemIds === undefined
        ? { from: input.from, rarities: input.rarities }
        : { asked: input.itemIds.length }),
      sold,
      gold,
    });

    const body: SellResponse = { sold, gold };
    return c.json(body);
  });

  /**
   * Разбор на материалы. GDD §6.3.
   *
   * ВТОРАЯ ПОЛОВИНА РАЗВИЛКИ «золото или ресурс»: тот же предмет либо
   * продан, либо разобран, и выбор необратим — обе операции его
   * удаляют. Развилки не было бы, будь лом обратим в золото; он
   * односторонний намеренно.
   *
   * Идентификаторы приходят списком, а не фильтром по редкости, как
   * у продажи: продажа — уборка мусора, разбор — решение по конкретной
   * вещи.
   */
  app.post(API_ROUTES.itemsDismantle, async (c) => {
    const profile = await playerOf(c);
    const input = await parseBody(c, dismantleInputSchema);
    const { dismantled, gained } = await dismantleItems(db, profile.id, input.itemIds);

    c.get('log').info('разбор предметов', {
      playerId: profile.id,
      asked: input.itemIds.length,
      dismantled,
      gained,
    });

    const body: DismantleResponse = { dismantled, gained };
    return c.json(body);
  });

  return app;
}
