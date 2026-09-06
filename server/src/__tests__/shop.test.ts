import { balance as balanceData } from '@extramundum/data';
import { ZONES } from '@extramundum/data/zones';
import {
  API_ROUTES,
  clearedLevel,
  economyBalanceSchema,
  segmentBounds,
  type InventoryResponse,
  type ShopBuyResponse,
  type ShopResponse,
  type StashTabResponse,
} from '@extramundum/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { players } from '../db/schema/game.ts';
import { zoneProgress } from '../db/schema/runs.ts';
import { priceOf } from '../items/prices.ts';
import { shopState, slotItem, slotPrice } from '../items/shop.ts';

import {
  createTestContext,
  databaseUrl,
  get,
  post,
  register,
  type CookieJar,
  type TestContext,
} from './helpers.ts';

const HAS_DB = databaseUrl() !== undefined;
const economy = economyBalanceSchema.parse(balanceData.economy);

/**
 * Лавка. GDD §6.3.
 *
 * Главное здесь — не то, что покупка работает, а два правила:
 * ассортимент идёт от ПРОЙДЕННОГО, а не от уровня игрока, и купить
 * один слот дважды за день нельзя.
 */
describe.skipIf(!HAS_DB)('лавка', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  const withGold = async (gold = 5_000_000) => {
    const { jar } = await register(ctx);
    const me = await get(ctx, API_ROUTES.me, jar);
    const playerId = (me.body as { player: { id: string } }).player.id;
    await ctx.db.update(players).set({ gold }).where(eq(players.id, playerId));
    return { jar, playerId };
  };

  const shop = async (jar: CookieJar): Promise<ShopResponse> => {
    const res = await get(ctx, API_ROUTES.shop, jar);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as unknown as ShopResponse;
  };

  const clear = async (playerId: string, zone: string, segments: number) => {
    await ctx.db
      .insert(zoneProgress)
      .values({ playerId, zone: zone as 'wastes', cleared: segments })
      .onConflictDoUpdate({
        target: [zoneProgress.playerId, zoneProgress.zone],
        set: { cleared: segments },
      });
  };

  describe('доступ', () => {
    it('без сессии витрина и покупка отвечают 401', async () => {
      expect((await get(ctx, API_ROUTES.shop)).status).toBe(401);
      expect((await post(ctx, API_ROUTES.shopBuy, { slot: 0 })).status).toBe(401);
    });
  });

  describe('ассортимент', () => {
    it('НОВИЧКУ — ТОВАР ПЕРВОГО УЧАСТКА, а не пустая полка', async () => {
      const { jar } = await withGold();
      const view = await shop(jar);

      const first = ZONES[0];
      if (first === undefined) throw new Error('нет зон');
      expect(view.level).toBe(segmentBounds(first, 0)[1]);
      expect(view.slots).toHaveLength(economy.shop.slots);
      for (const slot of view.slots) expect(slot.item.ilvl).toBe(view.level);
    });

    it('УРОВЕНЬ ТОВАРА РАСТЁТ ОТ ПРОЙДЕННОГО, а не от опыта игрока', async () => {
      /* Правило одно на всю игру: сила и уровень добычи идут от того,
         куда ты добрался. Лавка по уровню игрока вернула бы уровень
         через чёрный ход — нафармил опыта на первом участке и купил
         снаряжение, до которого не дошёл.

         Проверяется КРЕСТОМ: опыт вверх — товар тот же; участок
         пройден — товар глубже. Одной половины мало: «не зависит
         от опыта» верно и на лавке, которая не меняется вовсе. */
      const { jar, playerId } = await withGold();
      const base = (await shop(jar)).level;

      /* ПОДНИМАЕТСЯ И ОПЫТ, И САМ УРОВЕНЬ. Одного опыта мало: уровень
         в базе растёт только вместе с выбором драфта, поэтому проверка
         «опыт не влияет» прошла бы и на лавке, которая смотрит именно
         на `players.level`, — то есть ровно на той дыре, которую она
         должна ловить. Поймано диверсией, а не рассуждением. */
      await ctx.db
        .update(players)
        .set({ xp: sql`500000`, level: 30 })
        .where(eq(players.id, playerId));

      const grown = await shop(jar);
      expect(grown.level, 'уровень игрока поднял уровень товара').toBe(base);
      for (const slot of grown.slots) expect(slot.item.ilvl).toBe(base);

      await clear(playerId, 'wastes', 3);
      const deeper = (await shop(jar)).level;
      expect(deeper, 'пройденные участки не подняли уровень товара').toBeGreaterThan(base);

      const wastes = ZONES.find((zone) => zone.id === 'wastes');
      if (wastes === undefined) throw new Error('нет Пустошей');
      expect(deeper).toBe(segmentBounds(wastes, 2)[1]);
    });

    it('среди аргументов уровня товара НЕТ уровня игрока', async () => {
      /* Тот же формализм, что у `enemyLevel` и `isSegmentUnlocked`,
         и по той же причине: пока уровень игрока входил в расчёт
         врага, игра имела тупик, из которого не было выхода. */
      expect(clearedLevel.length).toBe(2);
    });
  });

  describe('цена', () => {
    it('ЦЕНА ПОКУПКИ СТРОГО ВЫШЕ ЦЕНЫ ПРОДАЖИ того же предмета', async () => {
      /* Иначе «купить и продать» становится насосом. Замок стоит
         в схеме баланса (наценка строго больше единицы), а здесь
         проверяется, что через оба конца он доехал. */
      const { jar } = await withGold();
      const view = await shop(jar);

      for (const slot of view.slots) {
        const item = slotItem(
          (await shopState(ctx.db, await idOf(jar))).seed,
          slot.slot,
          view.level,
        );
        expect(slot.price).toBe(slotPrice(item));
        expect(slot.price, `слот ${slot.slot}`).toBeGreaterThan(priceOf(item));
      }
    });
  });

  describe('покупка', () => {
    it('списывает золото и кладёт предмет в инвентарь', async () => {
      const { jar } = await withGold();
      const view = await shop(jar);
      const slot = view.slots[0];
      if (slot === undefined) throw new Error('витрина пуста');

      const res = await post(ctx, API_ROUTES.shopBuy, { slot: 0 }, jar);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const body = res.body as unknown as ShopBuyResponse;

      expect(body.gold).toBe(view.gold - slot.price);
      expect(body.item.baseKey).toBe(slot.item.baseKey);
      expect(body.item.ilvl).toBe(slot.item.ilvl);

      // Предмет получил НАСТОЯЩИЙ номер: на витрине его в таблице
      // предметов не было вовсе.
      expect(body.item.id).not.toBe(slot.item.id);
    });

    it('ОДИН СЛОТ — ОДНА ПОКУПКА В ДЕНЬ, и золото за вторую не берут', async () => {
      const { jar, playerId } = await withGold();
      await post(ctx, API_ROUTES.shopBuy, { slot: 1 }, jar);
      const after =
        (
          await ctx.db.select({ gold: players.gold }).from(players).where(eq(players.id, playerId))
        )[0]?.gold ?? 0;

      const second = await post(ctx, API_ROUTES.shopBuy, { slot: 1 }, jar);
      expect(second.status).toBe(409);

      const now =
        (
          await ctx.db.select({ gold: players.gold }).from(players).where(eq(players.id, playerId))
        )[0]?.gold ?? 0;
      expect(now).toBe(after);
      expect((await shop(jar)).slots[1]?.sold).toBe(true);
    });

    it('ДВЕ ОДНОВРЕМЕННЫЕ ПОКУПКИ ДАЮТ ОДИН ПРЕДМЕТ', async () => {
      /* Проверка «куплено ли» до вставки прошла бы у обоих запросов.
         Держит уникальный индекс (игрок, день, слот): вторая вставка
         не находит места и откатывает транзакцию целиком. */
      const { jar, playerId } = await withGold();
      const before = (await shop(jar)).gold;
      const price = (await shop(jar)).slots[2]?.price ?? 0;
      expect(price, 'товар бесплатен — проверять нечего').toBeGreaterThan(0);

      const [a, b] = await Promise.all([
        post(ctx, API_ROUTES.shopBuy, { slot: 2 }, jar),
        post(ctx, API_ROUTES.shopBuy, { slot: 2 }, jar),
      ]);

      const ok = [a, b].filter((res) => res.status === 200);
      expect(ok, 'куплено дважды').toHaveLength(1);

      const now =
        (
          await ctx.db.select({ gold: players.gold }).from(players).where(eq(players.id, playerId))
        )[0]?.gold ?? 0;
      expect(now).toBe(before - price);
    });

    it('без золота — отказ, и слот остаётся на витрине', async () => {
      const { jar } = await withGold(0);
      const res = await post(ctx, API_ROUTES.shopBuy, { slot: 0 }, jar);

      expect(res.status).toBe(409);
      expect((await shop(jar)).slots[0]?.sold).toBe(false);
    });

    it('слота вне витрины не существует', async () => {
      const { jar } = await withGold();
      const res = await post(ctx, API_ROUTES.shopBuy, { slot: economy.shop.slots }, jar);
      expect([404, 400]).toContain(res.status);
    });

    it('КУПЛЕННЫЙ СЛОТ НЕ ИСЧЕЗАЕТ С ПОЛКИ', async () => {
      // «Куда делся тот меч» не должно быть вопросом: слот остаётся
      // и подписан «куплено».
      const { jar } = await withGold();
      await post(ctx, API_ROUTES.shopBuy, { slot: 3 }, jar);
      const view = await shop(jar);

      expect(view.slots).toHaveLength(economy.shop.slots);
      expect(view.slots[3]?.sold).toBe(true);
    });
  });

  describe('фляги', () => {
    it('ЗАРЯДОВ ПО УМОЛЧАНИЮ НОЛЬ, и тиры всё равно показаны', async () => {
      /* Решение человека: первый забег без золота обязан быть возможен,
         и «идти без фляг» — это он и есть. Показаны при этом ВСЕ тиры,
         иначе игрок не узнает, что фляги бывают. */
      const { jar } = await withGold();
      const view = await shop(jar);

      expect(view.flasks).toHaveLength(economy.flasks.tiers.length);
      for (const flask of view.flasks) expect(flask.charges).toBe(0);
    });

    it('покупка прибавляет заряд и списывает золото', async () => {
      const { jar, playerId } = await withGold();
      const tier = (await shop(jar)).flasks[0];
      if (tier === undefined) throw new Error('в балансе нет фляг');
      expect(tier.price, 'фляга бесплатна — проверять нечего').toBeGreaterThan(0);

      const before =
        (
          await ctx.db.select({ gold: players.gold }).from(players).where(eq(players.id, playerId))
        )[0]?.gold ?? 0;
      const res = await post(ctx, API_ROUTES.shopFlask, { tier: tier.id }, jar);
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const now =
        (
          await ctx.db.select({ gold: players.gold }).from(players).where(eq(players.id, playerId))
        )[0]?.gold ?? 0;
      expect(now).toBe(before - tier.price);
      expect((await shop(jar)).flasks.find((f) => f.id === tier.id)?.charges).toBe(1);
    });

    it('ПОТОЛОК ЗАРЯДОВ ОТКАЗЫВАЕТ, а не берёт золото молча', async () => {
      const { jar, playerId } = await withGold();
      const tier = (await shop(jar)).flasks[0];
      if (tier === undefined) throw new Error('в балансе нет фляг');

      for (let i = 0; i < tier.max; i++) {
        const res = await post(ctx, API_ROUTES.shopFlask, { tier: tier.id }, jar);
        expect(res.status, `заряд ${i + 1}`).toBe(200);
      }

      const before =
        (
          await ctx.db.select({ gold: players.gold }).from(players).where(eq(players.id, playerId))
        )[0]?.gold ?? 0;
      const extra = await post(ctx, API_ROUTES.shopFlask, { tier: tier.id }, jar);

      expect(extra.status).toBe(409);
      const now =
        (
          await ctx.db.select({ gold: players.gold }).from(players).where(eq(players.id, playerId))
        )[0]?.gold ?? 0;
      expect(now, 'золото за непроданный заряд списано').toBe(before);
      expect((await shop(jar)).flasks.find((f) => f.id === tier.id)?.charges).toBe(tier.max);
    });

    it('без золота — отказ, и заряда не появляется', async () => {
      const { jar } = await withGold(0);
      const tier = (await shop(jar)).flasks[0];
      if (tier === undefined) throw new Error('в балансе нет фляг');

      expect((await post(ctx, API_ROUTES.shopFlask, { tier: tier.id }, jar)).status).toBe(409);
      expect((await shop(jar)).flasks.find((f) => f.id === tier.id)?.charges).toBe(0);
    });

    it('фляги, которой нет в балансе, не существует', async () => {
      const { jar } = await withGold();
      const res = await post(ctx, API_ROUTES.shopFlask, { tier: 'нет-такой' }, jar);
      expect(res.status).toBe(404);
    });
  });

  describe('вкладки стеша', () => {
    it('ВМЕСТИМОСТЬ РАСТЁТ ПОКУПКОЙ, и растёт там, где её сторожат', async () => {
      /* Вместимость считает одна функция на репозиторий: её зовут показ
         инвентаря и проверка при перекладывании. Второе место
         разошлось бы с первым, и игрок увидел бы «120 из 240» там,
         где сервер отказывает на 121-м. Проверяются ОБА места. */
      const { jar, playerId } = await withGold();
      const before = ((await get(ctx, API_ROUTES.items, jar)).body as unknown as InventoryResponse)
        .capacity.stash;

      const res = await post(ctx, API_ROUTES.shopStashTab, {}, jar);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const body = res.body as unknown as StashTabResponse;

      expect(body.owned).toBe(1);
      expect(body.capacity).toBe(before + economy.stashTabs.slotsPerTab);

      const after = ((await get(ctx, API_ROUTES.items, jar)).body as unknown as InventoryResponse)
        .capacity.stash;
      expect(after).toBe(body.capacity);

      const tabs =
        (
          await ctx.db
            .select({ tabs: players.stashTabs })
            .from(players)
            .where(eq(players.id, playerId))
        )[0]?.tabs ?? 0;
      expect(tabs).toBe(1);
    });

    it('цена идёт ПО ЛЕСТНИЦЕ, а не одна на все вкладки', async () => {
      const { jar } = await withGold();
      const prices = economy.stashTabs.prices;
      expect(prices.length, 'лестница цен пуста').toBeGreaterThan(1);
      expect(prices[0]).not.toBe(prices[1]);

      for (let i = 0; i < prices.length; i++) {
        const offer = (await shop(jar)).stashTabs;
        expect(offer.price, `вкладка ${i + 1}`).toBe(prices[i]);
        expect((await post(ctx, API_ROUTES.shopStashTab, {}, jar)).status).toBe(200);
      }

      // Лестница кончилась — цены больше нет, и покупка отказывает.
      expect((await shop(jar)).stashTabs.price).toBeNull();
      expect((await post(ctx, API_ROUTES.shopStashTab, {}, jar)).status).toBe(409);
    });

    it('ДВЕ ОДНОВРЕМЕННЫЕ ПОКУПКИ ДАЮТ ОДНУ ВКЛАДКУ', async () => {
      /* Условие `stash_tabs = ожидаемый` в самом UPDATE: иначе два
         запроса купили бы две вкладки по цене одной. */
      const { jar, playerId } = await withGold();
      const price = (await shop(jar)).stashTabs.price ?? 0;
      const before =
        (
          await ctx.db.select({ gold: players.gold }).from(players).where(eq(players.id, playerId))
        )[0]?.gold ?? 0;

      const [a, b] = await Promise.all([
        post(ctx, API_ROUTES.shopStashTab, {}, jar),
        post(ctx, API_ROUTES.shopStashTab, {}, jar),
      ]);

      const ok = [a, b].filter((res) => res.status === 200);
      expect(ok, 'куплено две вкладки разом').toHaveLength(1);

      const now = (
        await ctx.db
          .select({ gold: players.gold, tabs: players.stashTabs })
          .from(players)
          .where(eq(players.id, playerId))
      )[0];
      expect(now?.tabs).toBe(1);
      expect(now?.gold).toBe(before - price);
    });

    it('без золота — отказ, и вкладки не появляется', async () => {
      const { jar } = await withGold(0);
      expect((await post(ctx, API_ROUTES.shopStashTab, {}, jar)).status).toBe(409);
      expect((await shop(jar)).stashTabs.owned).toBe(0);
    });
  });

  describe('витрина не подделывается', () => {
    it('СОСТАВ ОДИН И ТОТ ЖЕ при показе и при покупке', async () => {
      /* Сток нигде не хранится: он выводится из серверного сида дня.
         Разойдись показ и покупка, лавка выставляла бы одно, а продавала
         другое — и разошлись бы они молча. */
      const { jar } = await withGold();
      const first = await shop(jar);
      const second = await shop(jar);
      expect(second.slots.map((s) => s.item.baseKey)).toEqual(
        first.slots.map((s) => s.item.baseKey),
      );

      const res = await post(ctx, API_ROUTES.shopBuy, { slot: 4 }, jar);
      const bought = (res.body as unknown as ShopBuyResponse).item;
      expect(bought.baseKey).toBe(first.slots[4]?.item.baseKey);
      expect(bought.affixes).toEqual(first.slots[4]?.item.affixes);
    });

    it('сид лавки не уходит клиенту', async () => {
      const { jar, playerId } = await withGold();
      const state = await shopState(ctx.db, playerId);
      const body = JSON.stringify((await get(ctx, API_ROUTES.shop, jar)).body);
      expect(body).not.toContain(state.seed);
    });
  });

  const idOf = async (jar: CookieJar): Promise<string> => {
    const me = await get(ctx, API_ROUTES.me, jar);
    return (me.body as { player: { id: string } }).player.id;
  };
});
