import { balance as balanceData, ITEM_BASES } from '@extramundum/data';
import {
  API_ROUTES,
  lootBalanceSchema,
  type EquipmentSlot,
  type InventoryResponse,
} from '@extramundum/shared';
import { generateItem } from '@extramundum/sim';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { items } from '../db/schema/items.ts';
import { grantItems, sellPrice, type NewItem } from '../items/repository.ts';
import { players } from '../db/schema/game.ts';

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

/**
 * Инвентарь и экипировка против настоящей базы. GDD §5.3, §6.3, §6.4.
 *
 * Мока БД здесь нет намеренно: проверять надо ровно то, что стоит между
 * клиентом и базой, а мок это и выкидывает.
 */

describe.skipIf(!HAS_DB)('предметы', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  /**
   * Заводит игрока и кладёт ему предметы СЕРВЕРНОЙ функцией.
   *
   * Возвращает идентификаторы выданного. Искать выданное по индексу
   * в инвентаре нельзя: у игрока с первого дня есть стартовое оружие
   * (GDD §5.1), и «первый предмет» — это уже не тот, что положили.
   */
  const withItems = async (spec: readonly NewItem[]) => {
    const { jar } = await register(ctx);
    const me = await get(ctx, API_ROUTES.me, jar);
    const playerId = (me.body as { player: { id: string } }).player.id;
    const ids = await grantItems(ctx.db, playerId, spec);
    return { jar, playerId, ids };
  };

  /** Только выданное тестом: стартовое оружие в счёт не идёт. */
  const own = (inv: InventoryResponse, ids: readonly string[]) =>
    inv.items.filter((i) => ids.includes(i.id));

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

  const inventory = async (jar: CookieJar): Promise<InventoryResponse> => {
    const res = await get(ctx, API_ROUTES.items, jar);
    expect(res.status).toBe(200);
    return res.body as unknown as InventoryResponse;
  };

  describe('доступ', () => {
    it('без сессии все маршруты отвечают 401', async () => {
      expect((await get(ctx, API_ROUTES.items)).status).toBe(401);
      for (const [path, body] of [
        [API_ROUTES.itemsEquip, { itemId: '00000000-0000-0000-0000-000000000000' }],
        [API_ROUTES.itemsUnequip, { slot: 'weapon' }],
        [API_ROUTES.itemsMove, { itemId: '00000000-0000-0000-0000-000000000000', to: 'stash' }],
        [API_ROUTES.itemsLock, { itemId: '00000000-0000-0000-0000-000000000000', locked: true }],
        [API_ROUTES.itemsSell, { rarities: ['common'], from: 'inv' }],
      ] as const) {
        expect((await post(ctx, path, body)).status, path).toBe(401);
      }
    });
  });

  describe('изгнанного вывели ни с чем', () => {
    it('новый аккаунт получает РОВНО ОДНО: надетое стартовое оружие', async () => {
      /* Набор разработки существует только за флагом: он спорит и с лором
         (LORE §2), и с прогрессией, а источник лута — рейды.

         Оружие — исключение, и оно измерено, а не выторговано: с голыми
         кулаками игрок первого уровня выигрывает в Пустошах 0% боёв,
         то есть петля не начинается вовсе. GDD §5.1 стартовое оружие
         и требует. Подробности — в шапке starting-weapon.ts. */
      const { jar } = await register(ctx);
      const inv = await inventory(jar);

      expect(inv.items).toHaveLength(1);
      expect(inv.items[0]?.slot).toBe('weapon');
      expect(inv.items[0]?.rarity).toBe('common');
      // Надето, а не лежит в сумке: предмет в сумке от кулаков не спасает.
      expect(inv.items[0]?.container).toBe('equipped');
      expect(inv.equipped.weapon).toBe(inv.items[0]?.id);
      // Ноль аффиксов — стартовое оружие не опережает первый лут.
      expect(inv.items[0]?.affixes).toHaveLength(0);
      expect(inv.gold).toBe(0);
    });
  });

  describe('экипировка', () => {
    it('слот берётся ИЗ БАЗЫ предмета, а не из запроса', async () => {
      const boots = item('eq-boots', { ilvl: 20 });
      const { jar, ids } = await withItems([boots]);
      const inv = await inventory(jar);
      const first = own(inv, ids)[0];
      expect(first).toBeDefined();
      if (first === undefined) return;

      expect((await post(ctx, API_ROUTES.itemsEquip, { itemId: first.id }, jar)).status).toBe(200);

      const after = await inventory(jar);
      expect(after.equipped[first.slot]).toBe(first.id);
      expect(after.items.find((i) => i.id === first.id)?.container).toBe('equipped');
    });

    it('второй предмет в занятый слот возвращает первый в инвентарь', async () => {
      const { jar, ids } = await withItems([
        item('slot-a', { ilvl: 20 }),
        item('slot-a', { ilvl: 20 }),
      ]);
      const inv = await inventory(jar);
      const [a, b] = own(inv, ids);
      expect(a?.slot).toBe(b?.slot);
      if (a === undefined || b === undefined) return;

      await post(ctx, API_ROUTES.itemsEquip, { itemId: a.id }, jar);
      await post(ctx, API_ROUTES.itemsEquip, { itemId: b.id }, jar);

      const after = await inventory(jar);
      expect(after.equipped[a.slot]).toBe(b.id);
      expect(after.items.find((i) => i.id === a.id)?.container).toBe('inv');
      // Слот занят ровно одним: это держит уникальный индекс, а не код.
      expect(Object.values(after.equipped).filter((id) => id === a.id)).toHaveLength(0);
    });

    it('снятие возвращает предмет в инвентарь', async () => {
      const { jar, ids } = await withItems([item('uneq', { ilvl: 20 })]);
      const inv = await inventory(jar);
      const target = own(inv, ids)[0];
      if (target === undefined) return;

      await post(ctx, API_ROUTES.itemsEquip, { itemId: target.id }, jar);
      await post(ctx, API_ROUTES.itemsUnequip, { slot: target.slot }, jar);

      const after = await inventory(jar);
      expect(after.equipped[target.slot]).toBeUndefined();
      expect(after.items.find((i) => i.id === target.id)?.container).toBe('inv');
    });

    it('надетое меняет производные статы', async () => {
      /* Слот НЕ оружейный: стартовый меч уже надет, и предмет того же
         слота мог бы оказаться слабее — тогда «хоть что-то изменилось»
         проверялось бы на замене, а не на надевании. */
      const { jar, ids } = await withItems([item('stats', { ilvl: 30, slot: 'chest' })]);
      const before = await inventory(jar);
      const target = own(before, ids)[0];
      if (target === undefined) return;

      await post(ctx, API_ROUTES.itemsEquip, { itemId: target.id }, jar);
      const after = await inventory(jar);

      // Хоть что-то обязано измениться: предмет, ничего не меняющий,
      // — это пункт 4 аудита v1.0.
      const changed =
        after.stats.atk !== before.stats.atk ||
        after.stats.armor !== before.stats.armor ||
        after.stats.maxHp !== before.stats.maxHp ||
        after.stats.dmgMax !== before.stats.dmgMax ||
        after.stats.mightMultiplier !== before.stats.mightMultiplier;
      expect(changed).toBe(true);
    });
  });

  describe('инвентарь и стеш', () => {
    it('предмет перемещается между инвентарём и стешем', async () => {
      const { jar, ids } = await withItems([item('move', { ilvl: 10 })]);
      const target = own(await inventory(jar), ids)[0];
      if (target === undefined) return;

      expect(
        (await post(ctx, API_ROUTES.itemsMove, { itemId: target.id, to: 'stash' }, jar)).status,
      ).toBe(200);
      expect(own(await inventory(jar), ids)[0]?.container).toBe('stash');

      await post(ctx, API_ROUTES.itemsMove, { itemId: target.id, to: 'inv' }, jar);
      expect(own(await inventory(jar), ids)[0]?.container).toBe('inv');
    });

    it('надетый предмет переместить нельзя', async () => {
      const { jar, ids } = await withItems([item('move-eq', { ilvl: 10 })]);
      const target = own(await inventory(jar), ids)[0];
      if (target === undefined) return;

      await post(ctx, API_ROUTES.itemsEquip, { itemId: target.id }, jar);
      const res = await post(ctx, API_ROUTES.itemsMove, { itemId: target.id, to: 'stash' }, jar);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { messageKey: 'error.item.equipped' } });
    });
  });

  describe('массовая продажа', () => {
    it('продаёт по фильтру редкости и начисляет золото', async () => {
      const { jar, playerId, ids } = await withItems([
        item('sell-1', { rarity: 'common' }),
        item('sell-2', { rarity: 'common' }),
        item('sell-3', { rarity: 'rare' }),
      ]);

      const before = await inventory(jar);
      const commons = own(before, ids).filter((i) => i.rarity === 'common');
      expect(commons).toHaveLength(2);

      const res = await post(ctx, API_ROUTES.itemsSell, { rarities: ['common'], from: 'inv' }, jar);
      expect(res.status).toBe(200);
      // Пометки `provisional` больше нет: цена считается настоящей
      // формулой (§6.3, items.sell) — редкость, уровень и качество
      // аффиксов. Абсолютная шкала ждёт стоков, форма окончательна.
      expect(res.body).toMatchObject({ sold: 2 });

      const after = await inventory(jar);
      // Считаем ТОЛЬКО выданное тестом: стартовое оружие надето
      // и под фильтр «из инвентаря» не попадает по определению.
      expect(own(after, ids)).toHaveLength(1);
      expect(own(after, ids)[0]?.rarity).toBe('rare');

      // Золото начислено, а не потеряно: удаление без выплаты было бы
      // необратимым разрушением без компенсации.
      const gold = (res.body as { gold: number }).gold;
      expect(gold).toBeGreaterThan(0);
      expect(after.gold).toBe(gold);

      const rows = await ctx.db.select().from(players).where(eq(players.id, playerId));
      expect(rows[0]?.gold).toBe(gold);
    });

    it('ЗАБЛОКИРОВАННЫЙ не продаётся, даже попав под фильтр', async () => {
      const { jar, ids } = await withItems([
        item('lock-1', { rarity: 'common' }),
        item('lock-2', { rarity: 'common' }),
      ]);
      const before = await inventory(jar);
      const locked = own(before, ids)[0];
      if (locked === undefined) return;

      await post(ctx, API_ROUTES.itemsLock, { itemId: locked.id, locked: true }, jar);
      const res = await post(ctx, API_ROUTES.itemsSell, { rarities: ['common'], from: 'inv' }, jar);

      // Продан ровно один из двух: значит фильтр РАБОТАЛ и замок его
      // остановил. «Ноль продано» прошло бы и при сломанном фильтре.
      expect(res.body).toMatchObject({ sold: 1 });
      const after = await inventory(jar);
      expect(own(after, ids)).toHaveLength(1);
      expect(own(after, ids)[0]?.id).toBe(locked.id);
      expect(own(after, ids)[0]?.locked).toBe(true);
    });

    it('надетое не продаётся: оно не в инвентаре', async () => {
      /* Слот задан ЯВНО и не оружейный: надев оружие, мы вытеснили бы
         стартовое в инвентарь, оно тоже обычной редкости и продалось бы.
         Тест проверяет «надетое не продаётся», а не это. */
      const { jar, ids } = await withItems([item('sell-eq', { rarity: 'common', slot: 'helmet' })]);
      const target = own(await inventory(jar), ids)[0];
      if (target === undefined) return;

      await post(ctx, API_ROUTES.itemsEquip, { itemId: target.id }, jar);
      const res = await post(ctx, API_ROUTES.itemsSell, { rarities: ['common'], from: 'inv' }, jar);

      expect(res.body).toMatchObject({ sold: 0, gold: 0 });
      expect(own(await inventory(jar), ids)).toHaveLength(1);
    });

    it('цена зависит от редкости и ilvl', async () => {
      // Формула провизорная (экономика — M3c), но она обязана быть
      // МОНОТОННОЙ: иначе продавать эпик выгоднее по одному, а это
      // не решение дизайна, а баг.
      const cheap = sellPrice({
        id: 'x',
        baseKey: 'ring.band',
        slot: 'ring',
        ilvl: 1,
        rarity: 'common',
        affixes: [],
        upgradeLevel: 0,
        locked: false,
        container: 'inv',
      });
      const rich = sellPrice({
        id: 'y',
        baseKey: 'ring.band',
        slot: 'ring',
        ilvl: 40,
        rarity: 'epic',
        affixes: [],
        upgradeLevel: 0,
        locked: false,
        container: 'inv',
      });
      expect(rich).toBeGreaterThan(cheap);
    });
  });

  describe('инвариант 1: клиент не может выдать себе предмет', () => {
    it('среди маршрутов нет ни одного, создающего предмет', async () => {
      const { jar } = await register(ctx);
      // Попытки «создать» предмет любым правдоподобным способом.
      for (const [path, body] of [
        [API_ROUTES.items, { baseKey: 'weapon.axe', ilvl: 200, rarity: 'legendary' }],
        [API_ROUTES.itemsEquip, { baseKey: 'weapon.axe', ilvl: 200, rarity: 'legendary' }],
        [API_ROUTES.itemsMove, { baseKey: 'weapon.axe', to: 'inv' }],
      ] as const) {
        const res = await post(ctx, path, body, jar);
        expect([400, 404, 405], `${path} ответил ${res.status}`).toContain(res.status);
      }

      /* Инвентарь не вырос. Стартовое оружие тут ни при чём: его выдаёт
         сервер при создании профиля, а не запрос клиента, — потому
         и сравнение с единицей, а не с нулём. */
      expect((await inventory(jar)).items).toHaveLength(1);
    });

    it('чужой предмет не надевается и не отличим от несуществующего', async () => {
      const owner = await withItems([item('mine', { ilvl: 20 })]);
      const stranger = await register(ctx);

      const target = own(await inventory(owner.jar), owner.ids)[0];
      if (target === undefined) return;

      const foreign = await post(ctx, API_ROUTES.itemsEquip, { itemId: target.id }, stranger.jar);
      const missing = await post(
        ctx,
        API_ROUTES.itemsEquip,
        { itemId: '00000000-0000-0000-0000-000000000000' },
        stranger.jar,
      );

      // Одинаковый ответ: иначе 404 против 403 становится способом
      // узнать, существует ли чужой предмет с таким идентификатором.
      //
      // Сравнивается конверт БЕЗ requestId: он свой у каждого ответа
      // и к различимости отношения не имеет.
      const envelope = (body: unknown) => {
        const e = (body as { error: Record<string, unknown> }).error;
        const { requestId: _ignored, ...rest } = e;
        return rest;
      };

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(envelope(foreign.body)).toEqual(envelope(missing.body));

      // И предмет остался у владельца.
      expect(own(await inventory(owner.jar), owner.ids)[0]?.container).toBe('inv');
    });

    it('лишние поля в теле игнорируются, сила предмета не меняется', async () => {
      const { jar, ids } = await withItems([item('extra', { ilvl: 5 })]);
      const before = own(await inventory(jar), ids)[0];
      if (before === undefined) return;

      await post(
        ctx,
        API_ROUTES.itemsEquip,
        {
          itemId: before.id,
          ilvl: 200,
          rarity: 'legendary',
          affixes: [{ family: 'might', tier: 'T1', value: 9 }],
        },
        jar,
      );

      const after = own(await inventory(jar), ids)[0];
      expect(after?.ilvl).toBe(before.ilvl);
      expect(after?.rarity).toBe(before.rarity);
      expect(after?.affixes).toEqual(before.affixes);

      const rows = await ctx.db.select().from(items).where(eq(items.id, before.id));
      expect(rows[0]?.ilvl).toBe(before.ilvl);
    });
  });

  describe('превью при экипировке (GDD §6.4)', () => {
    it('возвращает и текущий шанс, и шанс с правкой, и дельты', async () => {
      const { jar, ids } = await withItems([item('prev', { ilvl: 40, rarity: 'epic' })]);
      const target = own(await inventory(jar), ids)[0];
      if (target === undefined) return;

      const res = await post(
        ctx,
        API_ROUTES.simulatePreview,
        {
          zone: 'wastes',
          difficulty: 'normal',
          loadoutHash: 'a'.repeat(64),
          runs: 50,
          change: { kind: 'equip', itemId: target.id },
        },
        jar,
      );

      expect(res.status).toBe(200);
      const body = res.body as {
        winRate: number;
        baseWinRate: number;
        deltas: Record<string, number>;
      };
      expect(body.baseWinRate).toBeGreaterThanOrEqual(0);
      expect(Object.keys(body.deltas).length).toBeGreaterThan(0);

      // Превью НИЧЕГО не меняет: предмет остался не надетым.
      expect(own(await inventory(jar), ids)[0]?.container).toBe('inv');
    });

    it('без правки отдаёт только текущий шанс', async () => {
      const { jar } = await register(ctx);
      const res = await post(
        ctx,
        API_ROUTES.simulatePreview,
        { zone: 'wastes', difficulty: 'normal', loadoutHash: 'a'.repeat(64), runs: 50 },
        jar,
      );

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('baseWinRate');
      expect(res.body).not.toHaveProperty('deltas');
    });
  });
});
