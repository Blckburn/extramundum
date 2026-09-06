import { balance as balanceData } from '@extramundum/data';
import {
  API_ROUTES,
  economyBalanceSchema,
  flaskBuyInputSchema,
  flaskPrice,
  lootBalanceSchema,
  shopBuyInputSchema,
  stashCapacity,
  stashTabInputSchema,
  stashTabPrice,
  type FlaskBuyResponse,
  type FlaskOffer,
  type StashTabOffer,
  type StashTabResponse,
  type ShopBuyResponse,
  type ShopResponse,
  type ShopSlot,
} from '@extramundum/shared';
import { Hono, type Context } from 'hono';

import { requireSession } from '../auth/session.ts';
import type { Database } from '../db/client.ts';
import { AppError } from '../http/errors.ts';
import { parseBody, type AppEnv } from '../http/middleware.ts';
import { toView } from '../items/loadout.ts';
import { buyFlask, readFlasks } from '../items/flasks.ts';
import { buySlot, buyStashTab, shopState, slotItem, slotPrice } from '../items/shop.ts';
import { findPlayerByUserId } from '../players/repository.ts';

/**
 * Лавка. GDD §6.3.
 *
 * В теле покупки — НОМЕР СЛОТА, и больше ничего. Ни предмета, ни цены:
 * и то, и другое сервер выводит из серверного сида дня заново, как
 * оффер драфта. Прислать «что покупаю» нечем — схема такого поля
 * не содержит (инвариант 1).
 */
const economy = economyBalanceSchema.parse(balanceData.economy);
const loot = lootBalanceSchema.parse(balanceData.items);

export function shopRoutes(db: Database): Hono<AppEnv> {
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
    return profile;
  };

  app.get(API_ROUTES.shop, async (c) => {
    const profile = await playerOf(c);
    const state = await shopState(db, profile.id);

    const slots: ShopSlot[] = [];
    for (let slot = 0; slot < economy.shop.slots; slot++) {
      const item = slotItem(state.seed, slot, state.level);
      const price = slotPrice(item);
      slots.push({
        slot,
        item: toView(item, null),
        price,
        affordable: state.gold >= price,
        // Купленный слот НЕ ИСЧЕЗАЕТ: пустая полка — тоже итог,
        // и «куда делся тот меч» не должно быть вопросом.
        sold: state.sold.has(slot),
      });
    }

    /* ФЛЯГИ НА ТОМ ЖЕ ПРИЛАВКЕ, а не отдельным экраном: и то, и другое
       покупается за золото, и держать их врозь значило бы заставлять
       игрока считать бюджет между двумя экранами. */
    const stock = await readFlasks(db, profile.id);
    const flasks: FlaskOffer[] = economy.flasks.tiers.map((tier) => {
      const price = flaskPrice(tier.id, economy, state.level);
      const charges = stock[tier.id] ?? 0;
      return {
        id: tier.id,
        price,
        restore: tier.restore,
        side:
          tier.side === null
            ? null
            : { good: tier.side.good, bad: tier.side.bad, chance: tier.side.chance },
        charges,
        max: economy.flasks.maxCharges,
        affordable: state.gold >= price && charges < economy.flasks.maxCharges,
      };
    });

    /* ВКЛАДКИ СТЕША — ЕДИНСТВЕННЫЙ СТОК, КОТОРЫЙ НЕ НАСЫЩАЕТСЯ
       по смыслу: кузнец упирается в улучшенный комплект, фляги —
       в полный запас, а место под вещи нужно ровно столько, сколько
       вещей копится. Без него золото снова копится впустую — ровно
       провал v1.0, только на две недели позже. */
    const owned = profile.stashTabs;
    const price = stashTabPrice(owned, economy);
    const stashTabs: StashTabOffer = {
      owned,
      price,
      capacity: stashCapacity(owned, loot.capacity.stash, economy),
      slotsPerTab: economy.stashTabs.slotsPerTab,
      affordable: price !== null && state.gold >= price,
    };

    const body: ShopResponse = {
      gold: state.gold,
      slots,
      flasks,
      stashTabs,
      level: state.level,
    };
    return c.json(body);
  });

  app.post(API_ROUTES.shopBuy, async (c) => {
    const profile = await playerOf(c);
    const input = await parseBody(c, shopBuyInputSchema);
    const { gold, item } = await buySlot(db, profile.id, input.slot);

    c.get('log').info('покупка в лавке', {
      playerId: profile.id,
      slot: input.slot,
      baseKey: item.baseKey,
      ilvl: item.ilvl,
    });

    const body: ShopBuyResponse = { gold, item: toView(item, null) };
    return c.json(body);
  });

  /**
   * Купить заряд фляги. GDD §6.3: «пополнение зелий — сток
   * на каждом забеге».
   *
   * Единственный сток, который тратится КАЖДЫЙ забег, а не один раз
   * на предмет: кузнец и вкладки насыщаются, фляги — нет.
   */
  app.post(API_ROUTES.shopFlask, async (c) => {
    const profile = await playerOf(c);
    const input = await parseBody(c, flaskBuyInputSchema);
    const state = await shopState(db, profile.id);
    const { gold, charges } = await buyFlask(db, profile.id, input.tier, state.level);

    c.get('log').info('покупка фляги', { playerId: profile.id, tier: input.tier, charges });

    const body: FlaskBuyResponse = { gold, tier: input.tier, charges };
    return c.json(body);
  });

  /**
   * Купить вкладку стеша. GDD §6.3.
   *
   * ТЕЛА НЕТ: какая вкладка следующая, сервер знает из числа уже
   * купленных. Принимать номер значило бы дать купить четвёртую
   * по цене третьей.
   */
  app.post(API_ROUTES.shopStashTab, async (c) => {
    const profile = await playerOf(c);
    await parseBody(c, stashTabInputSchema);
    const { gold, owned } = await buyStashTab(db, profile.id);

    c.get('log').info('покупка вкладки стеша', { playerId: profile.id, owned });

    const body: StashTabResponse = {
      gold,
      owned,
      capacity: stashCapacity(owned, loot.capacity.stash, economy),
    };
    return c.json(body);
  });

  return app;
}
