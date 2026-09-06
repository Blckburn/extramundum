import { balance as balanceData, ITEM_BASES } from '@extramundum/data';
import {
  API_ROUTES,
  economyBalanceSchema,
  lootBalanceSchema,
  respecCost,
  upgradeCost,
  type EquipmentSlot,
  type InventoryResponse,
  type ReforgeResponse,
  type SmithViewResponse,
  type UpgradeResponse,
} from '@extramundum/shared';
import { generateItem } from '@extramundum/sim';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { players } from '../db/schema/game.ts';
import { items } from '../db/schema/items.ts';
import { derive } from '../items/loadout.ts';
import { grantMaterials } from '../items/materials.ts';
import { grantItems, type NewItem } from '../items/repository.ts';

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
const loot = lootBalanceSchema.parse(balanceData.items);
const economy = economyBalanceSchema.parse(balanceData.economy);
const upgradeBalance = balanceData.items.upgrade;

/**
 * Кузнец против настоящей базы. GDD §6.3, §5.2.
 *
 * Главный сток золота, и главное, что здесь проверяется, — не то,
 * что операции работают, а то, что за них ПЛАТЯТ и что заплаченное
 * не возвращается обходным путём.
 */
describe.skipIf(!HAS_DB)('кузнец', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  const item = (
    seed: string,
    over: Partial<NewItem> & { ilvl?: number; slot?: EquipmentSlot } = {},
  ): NewItem => {
    const { slot, ...rest } = over;
    const generated = generateItem(
      seed,
      {
        ilvl: over.ilvl ?? 20,
        ...(over.rarity === undefined ? {} : { rarity: over.rarity }),
        ...(slot === undefined ? {} : { slot }),
      },
      loot,
      ITEM_BASES,
    );
    return { ...generated, container: over.container ?? 'inv', ...rest };
  };

  /** Игрок, у которого точно хватит на что угодно из этого файла. */
  const rich = async (spec: readonly NewItem[]) => {
    const { jar } = await register(ctx);
    const me = await get(ctx, API_ROUTES.me, jar);
    const playerId = (me.body as { player: { id: string } }).player.id;
    const ids = await grantItems(ctx.db, playerId, spec);

    await ctx.db.update(players).set({ gold: 5_000_000 }).where(eq(players.id, playerId));
    await ctx.db.transaction((tx) =>
      grantMaterials(tx, playerId, {
        T1: 100_000,
        T2: 100_000,
        T3: 100_000,
        T4: 100_000,
        T5: 100_000,
        ember: 100_000,
      }),
    );
    return { jar, playerId, ids };
  };

  const smith = async (jar: CookieJar): Promise<SmithViewResponse> => {
    const res = await get(ctx, API_ROUTES.smith, jar);
    expect(res.status).toBe(200);
    return res.body as unknown as SmithViewResponse;
  };

  const goldOf = async (playerId: string): Promise<number> =>
    (await ctx.db.select({ gold: players.gold }).from(players).where(eq(players.id, playerId)))[0]
      ?.gold ?? 0;

  const rowOf = async (itemId: string) =>
    (await ctx.db.select().from(items).where(eq(items.id, itemId)))[0];

  describe('доступ', () => {
    it('без сессии все маршруты кузнеца отвечают 401', async () => {
      const id = '00000000-0000-0000-0000-000000000000';
      expect((await get(ctx, API_ROUTES.smith)).status).toBe(401);
      for (const [path, body] of [
        [API_ROUTES.smithUpgrade, { itemId: id }],
        [API_ROUTES.smithReforge, { itemId: id, affixIndex: 0 }],
        [API_ROUTES.smithRarityUp, { itemId: id }],
        [API_ROUTES.smithRespec, {}],
      ] as const) {
        expect((await post(ctx, path, body)).status, path).toBe(401);
      }
    });

    it('ЧУЖОЙ ПРЕДМЕТ НЕ ОТЛИЧИМ ОТ НЕСУЩЕСТВУЮЩЕГО', async () => {
      const mine = await rich([]);
      const other = await rich([item('smith-other')]);
      const target = other.ids[0];
      if (target === undefined) throw new Error('предмет не выдан');

      const res = await post(ctx, API_ROUTES.smithUpgrade, { itemId: target }, mine.jar);
      expect(res.status).toBe(404);
      expect((await rowOf(target))?.upgradeLevel).toBe(0);
    });
  });

  describe('улучшение', () => {
    it('БЕЗРИСКОВЫЕ УРОВНИ ПРОХОДЯТ ВСЕГДА и стоят золота с ломом', async () => {
      const { jar, playerId, ids } = await rich([item('smith-up', { ilvl: 20 })]);
      const itemId = ids[0];
      if (itemId === undefined) throw new Error('предмет не выдан');

      for (let to = 1; to <= upgradeBalance.riskFreeThrough; to++) {
        const before = await goldOf(playerId);
        const price = upgradeCost(to, 20, economy, upgradeBalance.riskFreeThrough);
        expect(price.success, `до +${to} обещан риск`).toBe(1);
        expect(price.gold, 'улучшение бесплатно — проверять нечего').toBeGreaterThan(0);

        const res = await post(ctx, API_ROUTES.smithUpgrade, { itemId }, jar);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const body = res.body as unknown as UpgradeResponse;

        expect(body.succeeded).toBe(true);
        expect(body.item.upgradeLevel).toBe(to);
        expect(await goldOf(playerId)).toBe(before - price.gold);
      }
    });

    it('УЛУЧШЕНИЕ ДОХОДИТ ДО ЧИСЕЛ ПРЕДМЕТА, а не только до надписи', async () => {
      /* Колонка `upgrade_level` существовала с M3a и не влияла ни на что:
         в описании было бы «+10%», в бою ноль — §13 пункт 4 в чистом
         виде. Проверяется ТА ЖЕ функция `derive`, из которой числа
         берёт и боец: второго способа посчитать урон предмета нет. */
      /* Слот закреплён ОРУЖИЕМ: у случайной базы могло не оказаться
         ни урона, ни брони (фокус даёт только statusPower), и тест
         сравнивал бы undefined с undefined. */
      const { jar, ids } = await rich([item('smith-derive', { ilvl: 20, slot: 'weapon' })]);
      const itemId = ids[0];
      if (itemId === undefined) throw new Error('предмет не выдан');

      const before = await rowOf(itemId);
      if (before === undefined) throw new Error('предмета нет');
      const beforeDerived = derive({
        id: before.id,
        baseKey: before.baseKey,
        slot: 'weapon',
        ilvl: before.ilvl,
        rarity: before.rarity,
        affixes: [],
        upgradeLevel: 0,
        locked: false,
        container: 'inv',
      });

      await post(ctx, API_ROUTES.smithUpgrade, { itemId }, jar);
      const after = await rowOf(itemId);
      if (after === undefined) throw new Error('предмета нет');
      const afterDerived = derive({
        id: after.id,
        baseKey: after.baseKey,
        slot: 'weapon',
        ilvl: after.ilvl,
        rarity: after.rarity,
        affixes: [],
        upgradeLevel: after.upgradeLevel,
        locked: false,
        container: 'inv',
      });

      const was = beforeDerived.dmgMax;
      const now = afterDerived.dmgMax;
      expect(was, 'у оружия нет урона — проверять нечего').toBeGreaterThan(0);
      expect(now).toBeGreaterThan(was ?? 0);
    });

    it('ПОТОЛОК ОТКАЗЫВАЕТ, а не берёт золото молча', async () => {
      const { jar, playerId, ids } = await rich([item('smith-cap', { ilvl: 20 })]);
      const itemId = ids[0];
      if (itemId === undefined) throw new Error('предмет не выдан');

      await ctx.db
        .update(items)
        .set({ upgradeLevel: upgradeBalance.maxLevel })
        .where(eq(items.id, itemId));

      const before = await goldOf(playerId);
      const res = await post(ctx, API_ROUTES.smithUpgrade, { itemId }, jar);

      expect(res.status).toBe(409);
      expect(await goldOf(playerId)).toBe(before);
    });

    it('ПРОВАЛ ОТНИМАЕТ УРОВЕНЬ, НО НЕ ЛОМАЕТ ПРЕДМЕТ', async () => {
      /* Выше +5 бросок настоящий, поэтому исход подбирается перебором
         попыток — но проверяется НЕ то, что провал случится, а то, что
         с предметом происходит при провале. Пара к проверке: успехи
         в той же выборке обязаны быть, иначе «предмет цел» верно
         и на сломанном кузнеце, который ничего не делает. */
      const { jar, ids } = await rich([item('smith-risk', { ilvl: 20 })]);
      const itemId = ids[0];
      if (itemId === undefined) throw new Error('предмет не выдан');

      let failures = 0;
      let successes = 0;

      for (let i = 0; i < 60 && (failures === 0 || successes === 0); i++) {
        const row = await rowOf(itemId);
        if (row === undefined) throw new Error('ПРЕДМЕТ ИСЧЕЗ: кузнец его сломал');
        if (row.upgradeLevel >= upgradeBalance.maxLevel) {
          await ctx.db
            .update(items)
            .set({ upgradeLevel: upgradeBalance.riskFreeThrough })
            .where(eq(items.id, itemId));
          continue;
        }

        const was = row.upgradeLevel;
        const res = await post(ctx, API_ROUTES.smithUpgrade, { itemId }, jar);
        expect(res.status).toBe(200);
        const body = res.body as unknown as UpgradeResponse;

        if (body.succeeded) {
          successes += 1;
          expect(body.item.upgradeLevel).toBe(was + 1);
        } else {
          failures += 1;
          expect(body.item.upgradeLevel, 'провал отнял больше одного уровня').toBe(
            Math.max(0, was - 1),
          );
        }
      }

      expect(successes, 'успехов не было — выборка не та').toBeGreaterThan(0);
      expect(failures, 'провалов не было — риск не проверен').toBeGreaterThan(0);
      // Главное: предмет на месте после всех попыток.
      expect(await rowOf(itemId)).toBeDefined();
    });

    it('ИСХОД НЕ ПЕРЕИГРАТЬ: счётчик растёт вместе со списанием', async () => {
      /* Детерминизм без роста счётчика означал бы, что неудачную
         попытку можно повторить тем же броском до победы. Счётчик
         двигается ТОЙ ЖЕ транзакцией, что платит, поэтому второй
         запрос считает уже другой бросок. */
      const { jar, ids } = await rich([item('smith-attempts', { ilvl: 20 })]);
      const itemId = ids[0];
      if (itemId === undefined) throw new Error('предмет не выдан');

      expect((await rowOf(itemId))?.smithAttempts).toBe(0);
      await post(ctx, API_ROUTES.smithUpgrade, { itemId }, jar);
      expect((await rowOf(itemId))?.smithAttempts).toBe(1);
      await post(ctx, API_ROUTES.smithUpgrade, { itemId }, jar);
      expect((await rowOf(itemId))?.smithAttempts).toBe(2);
    });

    it('СИД КУЗНЕЦА НЕ УХОДИТ КЛИЕНТУ НИ В ОДНОМ ОТВЕТЕ', async () => {
      /* Иначе детерминизм оборачивается против игры: с сидом игрок
         считает исход следующей попытки сам и жмёт только на удачные,
         а риск §6.3 исчезает вместе с назначением угля. */
      const { jar, playerId, ids } = await rich([item('smith-seed', { ilvl: 20 })]);
      const itemId = ids[0];
      if (itemId === undefined) throw new Error('предмет не выдан');

      const seed = (
        await ctx.db
          .select({ seed: players.smithSeed })
          .from(players)
          .where(eq(players.id, playerId))
      )[0]?.seed;
      expect(seed, 'сида нет — проверка пуста').toBeTruthy();

      const bodies = [
        JSON.stringify((await get(ctx, API_ROUTES.smith, jar)).body),
        JSON.stringify((await get(ctx, API_ROUTES.me, jar)).body),
        JSON.stringify((await post(ctx, API_ROUTES.smithUpgrade, { itemId }, jar)).body),
        JSON.stringify((await get(ctx, API_ROUTES.items, jar)).body),
      ].join('\n');

      expect(bodies).not.toContain(seed);
      // И счётчик попыток тоже: по нему с сидом считается бросок,
      // но сам по себе он безвреден — проверяется именно сид.
      expect(seed).not.toBe('');
    });

    it('без золота — отказ, и материалы остаются на месте', async () => {
      const { jar, playerId, ids } = await rich([item('smith-poor', { ilvl: 20 })]);
      const itemId = ids[0];
      if (itemId === undefined) throw new Error('предмет не выдан');
      await ctx.db.update(players).set({ gold: 0 }).where(eq(players.id, playerId));

      const before = await smith(jar);
      const res = await post(ctx, API_ROUTES.smithUpgrade, { itemId }, jar);

      expect(res.status).toBe(409);
      expect((await smith(jar)).materials).toEqual(before.materials);
      expect((await rowOf(itemId))?.smithAttempts, 'попытка засчитана без оплаты').toBe(0);
    });
  });

  describe('перековка', () => {
    it('меняет ОДИН аффикс и не трогает остальные', async () => {
      const { jar, ids } = await rich([item('smith-reforge', { ilvl: 30, rarity: 'epic' })]);
      const itemId = ids[0];
      if (itemId === undefined) throw new Error('предмет не выдан');

      const before = await rowOf(itemId);
      const beforeAffixes = before?.affixes as { family: string; tier: string; value: number }[];
      expect(beforeAffixes.length, 'у эпика нет аффиксов — перековывать нечего').toBeGreaterThan(1);

      const res = await post(ctx, API_ROUTES.smithReforge, { itemId, affixIndex: 0 }, jar);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const after = (res.body as unknown as ReforgeResponse).item.affixes;

      expect(after).toHaveLength(beforeAffixes.length);
      // Хвост не тронут — иначе это перекатывание всего предмета, то
      // есть ровно то, чем кузнец был в v1.0.
      expect(after.slice(1)).toEqual(beforeAffixes.slice(1));
    });

    it('несуществующий номер аффикса — отказ без списания', async () => {
      const { jar, playerId, ids } = await rich([item('smith-noaffix', { ilvl: 30 })]);
      const itemId = ids[0];
      if (itemId === undefined) throw new Error('предмет не выдан');

      const before = await goldOf(playerId);
      const res = await post(ctx, API_ROUTES.smithReforge, { itemId, affixIndex: 9 }, jar);

      expect(res.status).toBe(409);
      expect(await goldOf(playerId)).toBe(before);
    });
  });

  describe('повышение редкости', () => {
    it('поднимает на ступень и ДОБАВЛЯЕТ аффиксы, а не только надпись', async () => {
      const { jar, ids } = await rich([item('smith-rarity', { ilvl: 30, rarity: 'common' })]);
      const itemId = ids[0];
      if (itemId === undefined) throw new Error('предмет не выдан');

      const before = await rowOf(itemId);
      const beforeCount = (before?.affixes as unknown[]).length;

      const res = await post(ctx, API_ROUTES.smithRarityUp, { itemId }, jar);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const after = (res.body as unknown as ReforgeResponse).item;

      expect(after.rarity).toBe('magic');
      expect(
        after.affixes.length,
        '«много лома» купило одну надпись без единого аффикса',
      ).toBeGreaterThan(beforeCount);
    });

    it('ЭПИК НЕ ПОДНИМАЕТСЯ, и отказ приходит до списания', async () => {
      /* Отсутствие записи в балансе — это ОТКАЗ, а не нулевая цена.
         Ноль читался бы как «бесплатно», и потолок редкости
         превратился бы в его отсутствие. */
      const { jar, playerId, ids } = await rich([item('smith-epic', { ilvl: 30, rarity: 'epic' })]);
      const itemId = ids[0];
      if (itemId === undefined) throw new Error('предмет не выдан');

      const before = await goldOf(playerId);
      const res = await post(ctx, API_ROUTES.smithRarityUp, { itemId }, jar);

      expect(res.status).toBe(409);
      expect(await goldOf(playerId)).toBe(before);
      expect((await rowOf(itemId))?.rarity).toBe('epic');
      expect((await smith(jar)).offers.find((o) => o.item.id === itemId)?.rarityUp).toBeNull();
    });
  });

  describe('респек', () => {
    /** Довести игрока до уровня, где есть что сбрасывать. */
    const withPicks = async (jar: CookieJar, playerId: string) => {
      await ctx.db
        .update(players)
        .set({ xp: sql`100000` })
        .where(eq(players.id, playerId));

      for (let i = 0; i < 6; i++) {
        const draft = await get(ctx, API_ROUTES.draft, jar);
        const view = (draft.body as { draft: { options: { id: string }[] } }).draft;
        const first = view.options[0];
        if (first === undefined) break;
        await post(ctx, API_ROUTES.draftPick, { choice: first.id }, jar);
      }
    };

    it('СБРАСЫВАЕТ ВЫБОРЫ И ВОЗВРАЩАЕТ СТАТЫ К ДОДРАФТОВЫМ', async () => {
      /* Хранятся ВЫБОРЫ, а не сумма прибавок, и респек существует ровно
         затем: удаление строк, а не обратная арифметика. Проверяется
         поэтому не «строк нет», а что боец стал ТЕМ ЖЕ, каким был
         до драфта, — обратная арифметика на этом бы и села. */
      const { jar, playerId } = await rich([]);
      const virgin = ((await get(ctx, API_ROUTES.items, jar)).body as unknown as InventoryResponse)
        .stats;

      await withPicks(jar, playerId);
      const grown = ((await get(ctx, API_ROUTES.items, jar)).body as unknown as InventoryResponse)
        .stats;
      expect(grown, 'драфт ничего не изменил — сбрасывать нечего').not.toEqual(virgin);

      const view = await smith(jar);
      expect(view.respec.picks, 'выборов нет').toBeGreaterThan(0);

      const res = await post(ctx, API_ROUTES.smithRespec, {}, jar);
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const after = ((await get(ctx, API_ROUTES.items, jar)).body as unknown as InventoryResponse)
        .stats;
      expect(after).toEqual(virgin);
      expect((await smith(jar)).respec.picks).toBe(0);
    });

    it('стоит ровно 200 × уровень и списывает золото', async () => {
      const { jar, playerId } = await rich([]);
      await withPicks(jar, playerId);

      const level =
        (
          await ctx.db
            .select({ level: players.level })
            .from(players)
            .where(eq(players.id, playerId))
        )[0]?.level ?? 1;
      const price = respecCost(level, economy);
      expect(price, 'респек бесплатен — проверять нечего').toBeGreaterThan(0);

      const before = await goldOf(playerId);
      await post(ctx, API_ROUTES.smithRespec, {}, jar);
      expect(await goldOf(playerId)).toBe(before - price);
    });

    it('ПОСРЕДИ ЗАБЕГА ЗАПРЕЩЁН: ставка сделана этим билдом', async () => {
      const { jar, playerId } = await rich([]);
      await withPicks(jar, playerId);
      const before = await goldOf(playerId);

      const started = await post(
        ctx,
        API_ROUTES.runStart,
        { zone: 'wastes', segment: 0, difficulty: 'normal' },
        jar,
      );
      expect(started.status, 'забег не начался — запрет проверять не на чем').toBe(200);

      const res = await post(ctx, API_ROUTES.smithRespec, {}, jar);
      expect(res.status).toBe(409);
      expect(await goldOf(playerId)).toBe(before);
      expect((await smith(jar)).respec.picks).toBeGreaterThan(0);
    });
  });
});
