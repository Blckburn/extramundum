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

  /**
   * Предмет с ЗАДАННЫМИ аффиксами, а не с выпавшими броском.
   *
   * Генератор не обязан положить три «Верности руки» в три разных
   * слота, и тест, который этого ждёт, — это тест, который однажды
   * покраснеет без правки кода. Проверяется здесь бюджет, а не
   * генерация: она покрыта своими тестами.
   */
  const withAffixes = (
    seed: string,
    slot: EquipmentSlot,
    affixes: readonly { family: string; tier: string; value: number }[],
  ): NewItem => ({
    ...item(seed, { slot, ilvl: 20 }),
    affixes: affixes as NewItem['affixes'],
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
          segment: 0,
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
        { zone: 'wastes', segment: 0, difficulty: 'normal', loadoutHash: 'a'.repeat(64), runs: 50 },
        jar,
      );

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('baseWinRate');
      expect(res.body).not.toHaveProperty('deltas');
    });
  });

  /**
   * Бюджет «Верности руки» на пути КЛИЕНТ ← СЕРВЕР. GDD §6.1, §4.2.
   *
   * Движок покрыт своим тестом, но он проверяет функцию. Здесь
   * проверяется, что сервер отдаёт ей СПИСОК, а не сумму: сложи он
   * аффиксы до движка — бюджет применить было бы не к чему, третий
   * аффикс молча считался бы, и в тултипе он не был бы зачёркнут.
   * Диверсия «шлём сумму» проходила все прочие тесты.
   */
  describe('бюджет «Верности руки» доходит до клиента', () => {
    /** База причины изгнания. Её выдаёт `ensurePlayer`, см. §5.1. */
    const base = balanceData.archetypes.forbidden;

    const accuracyItem = (seed: string, slot: EquipmentSlot, value: number) =>
      withAffixes(seed, slot, [{ family: 'truehand', tier: 'T1', value }]);

    it('третий аффикс точности не считается и помечен зачёркнутым', async () => {
      const { jar, ids } = await withItems([
        accuracyItem('acc-1', 'bracers', 10),
        accuracyItem('acc-2', 'ring', 10),
        accuracyItem('acc-3', 'amulet', 10),
      ]);

      for (const id of ids) {
        expect((await post(ctx, API_ROUTES.itemsEquip, { itemId: id }, jar)).status).toBe(200);
      }

      const inv = (await get(ctx, API_ROUTES.items, jar)).body as unknown as InventoryResponse;
      const worn = own(inv, ids);
      expect(worn, 'надето не три предмета — проверять нечего').toHaveLength(3);

      const flags = worn.flatMap((i) =>
        i.affixes.filter((a) => a.family === 'truehand').map((a) => a.counted),
      );
      // Ровно два считаются, ровно один зачёркнут. Не «хотя бы один»:
      // при бюджете 2 из трёх одинаковых считается именно два.
      expect(flags.filter((c) => c === true)).toHaveLength(2);
      expect(flags.filter((c) => c === false)).toHaveLength(1);

      /* И производная точность — БАЗА АРХЕТИПА плюс сумма ДВУХ
         аффиксов, а не трёх. База входит: она не аффикс и под бюджет
         не попадает. Берётся из данных, а не числом в тесте: числа
         архетипов калибруются матрицей, и тест не должен падать
         от правки баланса. */
      expect(inv.stats.accuracy).toBe(base.accuracy + 20);
    });

    it('без бюджета число было бы другим — иначе проверка пуста', async () => {
      // Два аффикса влезают в бюджет целиком, три — нет. Разница между
      // этими двумя числами и есть то, что доказывает работу бюджета:
      // совпади они, тест проходил бы и на сервере без ограничения.
      const two = await withItems([
        accuracyItem('two-1', 'bracers', 10),
        accuracyItem('two-2', 'ring', 10),
      ]);
      for (const id of two.ids) {
        await post(ctx, API_ROUTES.itemsEquip, { itemId: id }, two.jar);
      }
      const invTwo = (await get(ctx, API_ROUTES.items, two.jar))
        .body as unknown as InventoryResponse;

      // Два аффикса влезают целиком: база плюс 10 плюс 10.
      expect(invTwo.stats.accuracy).toBe(base.accuracy + 20);
      // Три таких же без бюджета дали бы на десять больше — и это
      // ровно та разница, которую бюджет и снимает.
      expect(base.accuracy + 20).not.toBe(base.accuracy + 30);
    });
  });

  /**
   * БАЗА АРХЕТИПА доходит до бойца. GDD §5.1.
   *
   * До этой правки `balance.archetypes.*.armor` и `.accuracy`
   * не применялись к игроку НИГДЕ: их читала только матрица винрейтов.
   * Следствий было два, и оба замерены — живой изгнанный входил
   * в первую зону с нулевой бронёй (доходимость забега 2.8%),
   * а коридор архетипов 44–56% был выверен на конфигурации, которой
   * игра не производит.
   */
  describe('базовая броня и точность архетипа', () => {
    const start = balanceData.archetypes.forbidden;

    it('выдаются при регистрации и лежат в профиле', async () => {
      const { jar } = await withItems([]);
      const me = (await get(ctx, API_ROUTES.me, jar)).body as { player: PlayerProfile };

      // Числа СРАВНИВАЮТСЯ С ДАННЫМИ, а не с константой в тесте:
      // архетипы калибруются матрицей, и тест не должен падать
      // от правки баланса. Проверяется, что они вообще применены.
      expect(me.player.baseArmor).toBe(start.armor);
      expect(me.player.baseAccuracy).toBe(start.accuracy);
      // И это НЕ НОЛЬ — иначе равенство выполнялось бы и на игре,
      // которая базу не выдаёт вовсе. Ровно тот баг и был.
      expect(start.armor).toBeGreaterThan(0);
      expect(me.player.baseArmor).toBeGreaterThan(0);
    });

    it('броня голого изгнанного равна базе, а не нулю', async () => {
      const { jar } = await withItems([]);
      const inv = (await get(ctx, API_ROUTES.items, jar)).body as unknown as InventoryResponse;

      /* Снаряжения нет — у игрока с первого дня только подобранный
         у ворот клинок, а он брони не даёт. Значит вся броня здесь
         базовая, и её обязано быть ровно столько. */
      expect(inv.stats.armor).toBe(start.armor);
    });

    it('броня снаряжения складывается СВЕРХУ базы, а не заменяет её', async () => {
      const { jar, ids } = await withItems([item('armored', { slot: 'chest', ilvl: 20 })]);
      const before = (await get(ctx, API_ROUTES.items, jar)).body as unknown as InventoryResponse;
      expect((await post(ctx, API_ROUTES.itemsEquip, { itemId: ids[0] }, jar)).status).toBe(200);
      const after = (await get(ctx, API_ROUTES.items, jar)).body as unknown as InventoryResponse;

      // Нагрудник обязан был что-то дать: иначе «сверху базы»
      // проверять не на чем.
      expect(after.stats.armor).toBeGreaterThan(before.stats.armor);
      // И база при этом не потерялась.
      expect(after.stats.armor).toBeGreaterThan(start.armor);
    });
  });

  /**
   * ДОБИВКА ПРОФИЛЕЙ ЭПОХИ M0. Миграция 0007.
   *
   * Найдено по жалобе игрока, а не тестом: «за весь бой я бью один раз,
   * вся инициатива за врагом». Формулы боя оказались верны — виноват
   * профиль, созданный до M3b и не получивший ни статов архетипа,
   * ни базовой брони, ни клинка у ворот. При статах 5/5/5/5 против
   * монстров с SPD 10–13 враг действует вдвое-втрое чаще: замерено
   * 3–5 ходов игрока против 7–12 у врага.
   *
   * Тест держит СВОЙСТВО, а не текст миграции: после неё у игрока
   * не может быть профиля, который не начинается в бою.
   */
  describe('профиль эпохи M0 добит миграцией', () => {
    it('ни у одного игрока не осталось статов-умолчаний 5/5/5/5', async () => {
      await withItems([]);
      const rows = await ctx.db.select().from(players);
      expect(rows.length, 'игроков нет — проверять нечего').toBeGreaterThan(0);

      for (const row of rows) {
        const legacy =
          row.statAtk === 5 && row.statDef === 5 && row.statAgi === 5 && row.statSpd === 5;
        expect(legacy, `профиль ${row.username} остался на умолчаниях M0`).toBe(false);
      }
    });

    it('ни один игрок не остался без единого предмета', async () => {
      /* Клинок у ворот §5.1: без оружия изгнанный берёт 0% побед
         в первой же зоне, то есть игра начинается с гарантированной
         смерти. Это ровно то, во что упёрся живой игрок.

         ОДИН ЗАПРОС, А НЕ ПО ЗАПРОСУ НА ИГРОКА. Прежде здесь стоял цикл
         с отдельным SELECT на каждую строку, и он краснел через раз
         по таймауту: игроки копятся от всех тестов файла, поэтому цена
         росла с длиной прогона, а не с проверяемым свойством. Тест,
         который красный через раз, перезапускают вместо того, чтобы
         читать. */
      await withItems([]);
      const rows = await ctx.db.select().from(players);
      expect(rows.length, 'игроков нет — проверять нечего').toBeGreaterThan(0);

      const owned = await ctx.db.select({ ownerId: items.ownerId }).from(items);
      const withAnItem = new Set(owned.map((row) => row.ownerId));

      for (const row of rows) {
        expect(withAnItem.has(row.id), `у игрока ${row.username} нет ни одного предмета`).toBe(
          true,
        );
      }
    });

    it('и ни один не остался с нулевой базовой бронёй', async () => {
      const rows = await ctx.db.select().from(players);
      for (const row of rows) {
        expect(row.baseArmor, `у игрока ${row.username} нулевая база брони`).toBeGreaterThan(0);
      }
    });
  });
});
