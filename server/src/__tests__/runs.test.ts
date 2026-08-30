import { balance as balanceData, ITEM_BASES } from '@extramundum/data';
import { ZONES } from '@extramundum/data/zones';
import {
  API_ROUTES,
  EQUIPMENT_SLOTS,
  lootBalanceSchema,
  type InventoryResponse,
  type RunExtractResponse,
  type RunFightResponse,
  type RunResponse,
  type RunView,
  type ZonesResponse,
} from '@extramundum/shared';
import { generateItem } from '@extramundum/sim';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { players } from '../db/schema/game.ts';
import { runs } from '../db/schema/runs.ts';
import { grantItems } from '../items/repository.ts';
import { healBetweenFights, restoreFractionOf } from '../runs/service.ts';

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
const raid = balanceData.raid;
const loot = lootBalanceSchema.parse(balanceData.items);
/** Первая зона: у неё своё восстановление, и на ней всё это меряется. */
const WASTES = ZONES.find((zone) => zone.id === 'wastes')!;

/**
 * Забег с эвакуацией против настоящей базы. GDD §7.2, §7.3.
 *
 * Проверяется не «работает ли рейд», а то, ради чего он написан:
 * ЗАБЕГ НЕЛЬЗЯ ПОДДЕЛАТЬ С КЛИЕНТА. Смерть необратима, сумка теряется,
 * содержимое будущих боёв неизвестно, награда начисляется ровно один раз.
 *
 * Мока БД здесь нет: проверять надо ровно то, что стоит между клиентом
 * и базой, а мок это и выкидывает.
 */

describe.skipIf(!HAS_DB)('забег', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  /**
   * Игрок «в тир-снаряжении» — формулировка §4.6.
   *
   * Голый персонаж со стартовым мечом зону не проходит, и это не баг:
   * кривая зон обещает 85% ПОБЕД В БОЮ, а забег из пяти боёв с переносом
   * HP заведомо труднее. Тесты, которым нужен дошедший до пятого боя,
   * обязаны одевать игрока — иначе они проверяли бы не забег, а то,
   * повезло ли сегодня.
   */
  const gearUp = async (jar: CookieJar, ilvl = 8): Promise<void> => {
    const playerId = await playerIdOf(jar);
    const kit = EQUIPMENT_SLOTS.map((slot) => {
      const item = generateItem(
        `gear-${playerId}-${slot}`,
        { ilvl, slot, rarity: 'epic' },
        loot,
        ITEM_BASES,
      );
      return { ...item, affixes: [...item.affixes], container: 'inv' as const };
    });
    const ids = await grantItems(ctx.db, playerId, kit);
    for (const itemId of ids) {
      const res = await post(ctx, API_ROUTES.itemsEquip, { itemId }, jar);
      expect(res.status, `не надел ${itemId}`).toBe(200);
    }
  };

  const runOf = async (jar: CookieJar): Promise<RunView | null> => {
    const res = await get(ctx, API_ROUTES.run, jar);
    expect(res.status).toBe(200);
    return (res.body as unknown as RunResponse).run;
  };

  const start = async (
    jar: CookieJar,
    zone = 'wastes',
    difficulty = 'normal',
  ): Promise<RunView> => {
    const res = await post(ctx, API_ROUTES.runStart, { zone, difficulty }, jar);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const run = (res.body as unknown as RunResponse).run;
    expect(run).not.toBeNull();
    if (run === null) throw new Error('забег не создан');
    return run;
  };

  const fight = async (jar: CookieJar): Promise<RunFightResponse> => {
    const res = await post(ctx, API_ROUTES.runFight, {}, jar);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as unknown as RunFightResponse;
  };

  const inventory = async (jar: CookieJar): Promise<InventoryResponse> => {
    const res = await get(ctx, API_ROUTES.items, jar);
    expect(res.status).toBe(200);
    return res.body as unknown as InventoryResponse;
  };

  const profileRow = async (playerId: string) =>
    (await ctx.db.select().from(players).where(eq(players.id, playerId)))[0];

  const playerIdOf = async (jar: CookieJar): Promise<string> => {
    const me = await get(ctx, API_ROUTES.me, jar);
    return (me.body as { player: { id: string } }).player.id;
  };

  describe('доступ', () => {
    it('без сессии все маршруты забега отвечают 401', async () => {
      expect((await get(ctx, API_ROUTES.zones)).status).toBe(401);
      expect((await get(ctx, API_ROUTES.run)).status).toBe(401);
      for (const [path, body] of [
        [API_ROUTES.runStart, { zone: 'wastes', difficulty: 'normal' }],
        [API_ROUTES.runFight, {}],
        [API_ROUTES.runPotion, {}],
        [API_ROUTES.runExtract, {}],
      ] as const) {
        expect((await post(ctx, path, body)).status, path).toBe(401);
      }
    });
  });

  describe('вход в зону', () => {
    it('карточки зон приходят с готовыми числами, а не с формулой', async () => {
      const { jar } = await register(ctx);
      const res = await get(ctx, API_ROUTES.zones, jar);
      const body = res.body as unknown as ZonesResponse;

      expect(body.zones).toHaveLength(5);
      const wastes = body.zones.find((z) => z.id === 'wastes');
      expect(wastes).toBeDefined();
      if (wastes === undefined) return;

      // Уровень врага СЧИТАЕТ СЕРВЕР по §7.3 с ограничением зоны:
      // клиенту незачем знать формулу, и второго её места быть не должно.
      expect(wastes.difficulties.normal.enemyLevel).toBeGreaterThanOrEqual(wastes.levels[0]);

      /* ТИР РАЗЛИЧАЕТСЯ МНОЖИТЕЛЕМ, А НЕ УРОВНЕМ (§7.3 после правки).
         Раньше здесь стояло «у кошмара уровень выше», и это было верно
         ровно до тех пор, пока уровень не упирался в потолок диапазона:
         на верхушке зоны «опасно» и «кошмар» становились одним и тем же
         боем при разной оплате лутом. Теперь уровень одинаков, а тяжесть
         несёт множитель — и проверяется именно он. */
      expect(wastes.difficulties.nightmare.enemyLevel).toBe(wastes.difficulties.normal.enemyLevel);
      expect(wastes.difficulties.nightmare.power).toBeGreaterThan(
        wastes.difficulties.dangerous.power,
      );
      expect(wastes.difficulties.dangerous.power).toBeGreaterThan(wastes.difficulties.normal.power);
      // Множитель матчапа тоже готовым числом (§4.3, «ничего не спрятано»).
      expect(typeof wastes.matchup).toBe('number');

      /* И восстановление приходит ГОТОВЫМ ЧИСЛОМ, а не подписью
         в клиенте: величина зонная, и зона вправе её переопределить.
         Сейчас своего числа не задаёт ни одна, поэтому все отдают
         общее — но приходить оно обязано с сервера. */
      expect(wastes.hpRestore).toBe(restoreFractionOf(WASTES));
      for (const zone of body.zones) {
        expect(zone.hpRestore, zone.id).toBe(raid.hpRestoreBetweenFights);
      }

      expect(body.activeRun).toBeNull();
    });

    it('переросшая зона платит меньше, и карточка это показывает', async () => {
      const { jar } = await register(ctx);
      const playerId = await playerIdOf(jar);

      const before = (
        (await get(ctx, API_ROUTES.zones, jar)).body as unknown as ZonesResponse
      ).zones.find((z) => z.id === 'wastes')!.difficulties.nightmare;
      /* Новичок платит ПОЛНУЮ цену — иначе проверка ниже прошла бы
         и на игроке, которому урезали всегда, то есть не доказала бы,
         что урезание связано с уровнем. */
      expect(before.lootMultiplier).toBe(before.lootMultiplierBase);

      /* Уровень выше потолка Пустошей: уровень врага упирается
         в диапазон зоны, разница уровней исчезает — с ней обязана уйти
         и оплата. Это ровно тот фарм первой зоны на сороковом,
         который §7.3 объявляет бессмысленным. */
      await ctx.db.update(players).set({ level: 40 }).where(eq(players.id, playerId));

      const after = (
        (await get(ctx, API_ROUTES.zones, jar)).body as unknown as ZonesResponse
      ).zones.find((z) => z.id === 'wastes')!.difficulties.nightmare;

      // Враг тот же — потолок диапазона его держит.
      expect(after.enemyLevel).toBe(WASTES.levels[1]);
      expect(after.lootMultiplier).toBeLessThan(after.lootMultiplierBase);
      expect(after.lootMultiplier).toBeCloseTo(
        after.lootMultiplierBase * raid.lootLevelScale.floor,
        10,
      );
      /* Основание не поехало: игроку показывают, ОТ ЧЕГО урезали.
         Без этого числа урезание читалось бы как поломка. */
      expect(after.lootMultiplierBase).toBe(before.lootMultiplierBase);
    });

    it('второй забег начать нельзя', async () => {
      const { jar } = await register(ctx);
      await start(jar);
      const second = await post(
        ctx,
        API_ROUTES.runStart,
        { zone: 'wastes', difficulty: 'normal' },
        jar,
      );
      // Два забега сразу — это две сумки и возможность переложить риск.
      expect(second.status).toBe(409);
    });

    it('в зону без монстров войти нельзя', async () => {
      const { jar } = await register(ctx);
      // `rift` объявлен в перечислении, но отложен до M4. Пустить туда
      // значило бы отдать бой без противника.
      const res = await post(ctx, API_ROUTES.runStart, { zone: 'rift', difficulty: 'normal' }, jar);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('зона выше уровня заперта, и сервер отказывает, а не только экран', async () => {
      const { jar } = await register(ctx);
      const res = await get(ctx, API_ROUTES.zones, jar);
      const body = res.body as unknown as ZonesResponse;

      const wastes = body.zones.find((z) => z.id === 'wastes');
      const forge = body.zones.find((z) => z.id === 'forge');
      expect(wastes?.unlocked, 'первая зона обязана быть открыта новичку').toBe(true);
      // Проверка «запертая заперта» пуста, если запертых нет вовсе:
      // тогда она проходит и на игре без запирания.
      expect(forge?.unlocked, 'зона 24–32 не может быть открыта первому уровню').toBe(false);
      expect(forge?.minLevel).toBeGreaterThan(1);

      /* И ГЛАВНОЕ: отказывает СЕРВЕР, а не экран. Замок на карточке
         обходится одним запросом мимо интерфейса, и без этой проверки
         «Кошмар» в переросшей зоне остался бы бесплатным умножением
         добычи — уровень врага там зажат диапазоном и от сложности
         не зависит, а множитель лута ×2.5. */
      const denied = await post(
        ctx,
        API_ROUTES.runStart,
        { zone: 'forge', difficulty: 'nightmare' },
        jar,
      );
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ error: { messageKey: 'error.run.zoneLocked' } });
      expect(await runOf(jar), 'отказ не должен оставлять начатый забег').toBeNull();
    });

    it('свежий забег: пять боёв впереди, три зелья, пустая сумка', async () => {
      const { jar } = await register(ctx);
      const run = await start(jar);

      expect(run.fightIndex).toBe(0);
      expect(run.fightsTotal).toBe(raid.fightsPerRun);
      expect(run.potionsLeft).toBe(raid.potionChargesPerRun);
      expect(run.bag).toHaveLength(0);
      expect(run.hp).toBe(run.maxHp);
      // Уйти до первой развилки нельзя: рисковать ещё нечем (§7.2).
      expect(run.canExtract).toBe(false);
      // Следующий противник показан — на нём и строится решение.
      expect(run.next).not.toBeNull();
      expect(run.next?.boss).toBe(false);
    });
  });

  /**
   * Провести бои, пока в сумке не окажется добыча.
   *
   * СЛОЖНОСТЬ «КОШМАР» ВЗЯТА РАДИ ОПРЕДЕЛЁННОСТИ, а не ради трудности.
   * После снижения плотности втрое обычный бой роняет предмет реже чем
   * в половине случаев, и «подраться дважды и ждать лут» стало
   * проверкой удачи: на нормальной сложности за четыре боя пусто
   * примерно в одном прогоне из десяти. Красный через раз тест
   * перезапускают вместо того, чтобы читать.
   *
   * На «Кошмаре» множитель добычи ×2.5, и к третьему бою ожидание
   * переваливает за единицу — то есть предмет выпадает ГАРАНТИРОВАННО,
   * без броска на дробный остаток.
   */
  const fightUntilLoot = async (jar: CookieJar, { minFights = 1, limit = 3 } = {}) => {
    let result = await fight(jar);
    // `minFights` нужен эвакуации: уйти можно только после ВТОРОГО боя
    // (§7.2), и остановиться на первом значило бы проверять эвакуацию
    // там, где её ещё нет.
    for (let done = 1; done < limit && (done < minFights || result.run.bag.length === 0); done++) {
      result = await fight(jar);
    }
    expect(result.run.bag.length, 'за отведённые бои не выпало ничего').toBeGreaterThan(0);
    return result;
  };

  describe('сумка и эвакуация', () => {
    it('лут падает В СУМКУ, а не в инвентарь', async () => {
      const { jar } = await register(ctx);
      await gearUp(jar);
      const before = await inventory(jar);
      await start(jar, 'wastes', 'nightmare');

      /* Одного боя больше не хватает: плотность лута снижена втрое,
         и обычный бой роняет предмет реже чем в половине случаев.
         `fightUntilLoot` берёт «Кошмар» ради ОПРЕДЕЛЁННОСТИ — там
         к третьему бою ожидание переваливает за единицу, и предмет
         выпадает гарантированно. Проверяется не удача, а то, КУДА
         попадает добыча. */
      const result = await fightUntilLoot(jar);

      // Инвентарь не изменился: пока забег идёт, предмета в таблице
      // предметов нет вовсе — он лежит в сумке (§7.2).
      const after = await inventory(jar);
      expect(after.items).toHaveLength(before.items.length);
      for (const bagged of result.run.bag) {
        expect(after.items.find((i) => i.id === bagged.id)).toBeUndefined();
      }
    });

    it('эвакуация раньше второго боя запрещена', async () => {
      const { jar } = await register(ctx);
      await gearUp(jar);
      await start(jar);
      await fight(jar);

      const res = await post(ctx, API_ROUTES.runExtract, {}, jar);
      expect(res.status).toBe(409);
    });

    it('эвакуация переносит сумку в инвентарь под теми же номерами', async () => {
      const { jar } = await register(ctx);
      await gearUp(jar);
      await start(jar, 'wastes', 'nightmare');
      const second = await fightUntilLoot(jar, { minFights: 2 });

      expect(second.run.canExtract).toBe(true);
      const bagged = second.run.bag.map((i) => i.id);
      expect(bagged.length).toBeGreaterThan(0);

      const res = await post(ctx, API_ROUTES.runExtract, {}, jar);
      expect(res.status).toBe(200);
      const body = res.body as unknown as RunExtractResponse;

      expect(body.recovered).toBe(bagged.length);
      expect(body.run.state).toBe('extracted');
      expect(body.run.bag).toHaveLength(0);

      /* Номера СОХРАНЯЮТСЯ: игрок видел предмет в сумке под этим
         идентификатором, и менять его при переезде незачем. */
      const inv = await inventory(jar);
      for (const id of bagged) expect(inv.items.find((i) => i.id === id)).toBeDefined();
    });

    it('после эвакуации активного забега нет', async () => {
      const { jar } = await register(ctx);
      await gearUp(jar);
      await start(jar);
      await fight(jar);
      await fight(jar);
      await post(ctx, API_ROUTES.runExtract, {}, jar);

      expect(await runOf(jar)).toBeNull();
      // И можно начать новый — иначе игрок остался бы заперт.
      await start(jar);
    });
  });

  describe('смерть необратима', () => {
    /**
     * Гарантированная смерть В ОТКРЫТОЙ зоне.
     *
     * Раньше здесь были Чумные ямы на кошмаре — враг 32 уровня против
     * первого. Потом зоны заперли по уровню, и путь закрылся сервером;
     * заменой стала первая зона на «Кошмаре», где смещение +5 давало
     * врага шестого уровня против голого первого.
     *
     * ТЕПЕРЬ НЕ РАБОТАЕТ И ЭТО: тир перестал двигать уровень врага
     * (§7.3 после правки), он несёт множитель силы. Голый первый
     * уровень против врага первого уровня, пусть и на 24% сильнее,
     * гарантированно не умирает — а тест на смерть, который убивает
     * через раз, не проверяет ничего.
     *
     * Поэтому смерть готовится тем же приёмом, что и в `dieWithLoot`:
     * HP ставится в единицу прямой записью. Это подготовка СОСТОЯНИЯ,
     * а не обход механики — сам бой и его последствия идут обычным
     * путём через сервер.
     */
    const suicide = async (jar: CookieJar) => {
      const playerId = await playerIdOf(jar);
      await start(jar, 'wastes', 'nightmare');
      await ctx.db.update(players).set({ hpCurrent: 1 }).where(eq(players.id, playerId));

      const result = await fight(jar);
      expect(result.run.state, 'бой не убил — тест на смерть ничего не проверит').toBe('wiped');
      return result;
    };

    /**
     * Погибнуть С ПОЛНОЙ СУМКОЙ.
     *
     * Смерть в первом же бою ничего не доказывает про потерю сумки:
     * сумка там и так пуста, и проверка «после смерти пусто» проходит
     * при любой реализации. Поэтому сначала два выигранных боя, потом
     * HP ставится в единицу прямой записью — это подготовка состояния,
     * а не обход механики: сам бой и его последствия идут обычным путём.
     */
    const dieWithLoot = async (jar: CookieJar) => {
      await gearUp(jar);
      const playerId = await playerIdOf(jar);
      await start(jar, 'wastes', 'nightmare');
      const before = await fightUntilLoot(jar, { minFights: 2 });

      expect(before.run.state).toBe('active');
      expect(before.run.bag.length, 'сумка пуста — терять нечего').toBeGreaterThan(0);

      await ctx.db.update(players).set({ hpCurrent: 1 }).where(eq(players.id, playerId));
      return { doomed: before, result: await fight(jar), playerId };
    };

    it('погибший теряет сумку целиком, забег помечен wiped', async () => {
      const { jar } = await register(ctx);
      const { doomed, result } = await dieWithLoot(jar);

      expect(result.outcome.winner).toBe(1);
      expect(result.run.state).toBe('wiped');
      // Сумка БЫЛА непустой — и стала пустой. Это и есть ставка §7.2.
      expect(doomed.run.bag.length).toBeGreaterThan(0);
      expect(result.run.bag).toHaveLength(0);
      expect(result.rewards.loot).toHaveLength(0);
    });

    it('потерянная сумка НЕ доезжает до инвентаря', async () => {
      // Иначе «теряется» означало бы «переезжает молча», и проверить
      // это по одному лишь состоянию забега было бы нечем.
      const { jar } = await register(ctx);
      const { doomed } = await dieWithLoot(jar);

      const inv = await inventory(jar);
      for (const lost of doomed.run.bag) {
        expect(
          inv.items.find((i) => i.id === lost.id),
          `предмет ${lost.id} уцелел`,
        ).toBeUndefined();
      }
    });

    it('XP за пройденный бой остаётся, золото — половина', async () => {
      const { jar } = await register(ctx);
      const playerId = await playerIdOf(jar);
      const before = await profileRow(playerId);

      const result = await suicide(jar);
      const after = await profileRow(playerId);

      // XP начисляется целиком: «XP за пройденные бои остаётся» (§7.2).
      expect(after?.xp).toBe((before?.xp ?? 0) + result.rewards.xp);
      // Золото — половина, и это ПРОВЕРЯЕМОЕ число, а не «меньше».
      const expectedGold = Math.floor(result.rewards.gold * raid.goldKeptOnDeath);
      expect(after?.gold).toBe((before?.gold ?? 0) + expectedGold);
      expect(result.rewards.gold).toBeGreaterThan(0);
    });

    it('после смерти нельзя ни драться, ни эвакуироваться', async () => {
      const { jar } = await register(ctx);
      await suicide(jar);

      // Отменить смерть нечем: активного забега больше нет.
      expect(await runOf(jar)).toBeNull();
      expect((await post(ctx, API_ROUTES.runFight, {}, jar)).status).toBe(404);
      expect((await post(ctx, API_ROUTES.runExtract, {}, jar)).status).toBe(404);
    });
  });

  describe('награда начисляется ровно один раз', () => {
    it('два одновременных запроса на бой дают один бой и одну награду', async () => {
      const { jar } = await register(ctx);
      const playerId = await playerIdOf(jar);
      await start(jar);
      const before = await profileRow(playerId);

      /* ОДНОВРЕМЕННО, а не подряд: проверка «по коду вызывающего»
         здесь бессмысленна — два запроса проходят её оба. Защита
         обязана стоять в самом UPDATE, и проверять надо именно её. */
      const [a, b] = await Promise.all([
        post(ctx, API_ROUTES.runFight, {}, jar),
        post(ctx, API_ROUTES.runFight, {}, jar),
      ]);

      const ok = [a, b].filter((res) => res.status === 200);
      expect(ok, 'оба запроса прошли — награда начислена дважды').toHaveLength(1);

      const first = ok[0]?.body as unknown as RunFightResponse | undefined;
      expect(first).toBeDefined();
      if (first === undefined) return;

      const after = await profileRow(playerId);
      expect(after?.xp).toBe((before?.xp ?? 0) + first.rewards.xp);

      // И счётчик боёв сдвинулся ровно на один.
      const row = (await ctx.db.select().from(runs).where(eq(runs.id, first.run.runId)))[0];
      expect(row?.fightIndex).toBe(1);
    });
  });

  describe('перенос HP и зелья', () => {
    it('восстановление берётся ИЗ ЗОНЫ, а общее — только запасной вариант', () => {
      /* СЕЙЧАС СВОЕГО ЧИСЛА НЕТ НИ У ОДНОЙ ЗОНЫ, и это правильно:
         половина в Пустошах маскировала баг с базовой бронёй, и после
         его починки она стала лишней щедростью. Механизм при этом
         остался — зона вправе назначить своё число, — поэтому
         проверяется он, а не сегодняшние данные.

         Зона для «своего числа» СИНТЕТИЧЕСКАЯ. Взять настоящую значило
         бы, что тест молча превращается в тавтологию в тот день, когда
         из данных уберут последнее переопределение, — ровно это здесь
         и случилось. */
      const wastes = ZONES.find((zone) => zone.id === 'wastes');
      expect(wastes).toBeDefined();
      if (wastes === undefined) return;

      // Ни одна зона своего числа не задаёт — значит все берут общее.
      for (const zone of ZONES) {
        expect(restoreFractionOf(zone), zone.id).toBe(raid.hpRestoreBetweenFights);
      }

      // А назначенное зоной — перебивает общее.
      const generous = { ...wastes, hpRestoreBetweenFights: 0.5 };
      expect(restoreFractionOf(generous)).toBe(0.5);
      expect(restoreFractionOf(generous)).not.toBe(raid.hpRestoreBetweenFights);
    });

    it('формула восстановления: доля зоны сверху, но не выше максимума', () => {
      /* ЧИСТАЯ функция, поэтому проверяется точно и без боя. Разделение
         намеренное: здесь доказывается САМА формула — что доля берётся
         зонная, что восстановление частичное и что оно упирается
         в максимум. Ниже, в бою, доказывается, что сервер зовёт именно
         её. Пытаться доказать оба в одном интеграционном тесте значит
         привязать проверку формулы к тому, повезёт ли бойцу. */
      const zone = WASTES;
      const generous = { ...zone, hpRestoreBetweenFights: 0.5 };

      // Доля берётся ЗОННАЯ: то же состояние даёт разные числа.
      expect(healBetweenFights(20, 200, generous)).toBe(120);
      expect(healBetweenFights(20, 200, zone)).toBe(
        Math.round(20 + 200 * raid.hpRestoreBetweenFights),
      );

      // Частичное: раненый не становится целым.
      expect(healBetweenFights(20, 200, zone)).toBeLessThan(200);
      // И упирается в максимум, а не перескакивает его.
      expect(healBetweenFights(190, 200, generous)).toBe(200);
    });

    it('сервер применяет восстановление зоны к настоящему бою', async () => {
      const { jar } = await register(ctx);
      await gearUp(jar);
      await start(jar, 'wastes', 'dangerous');

      const restore = restoreFractionOf(WASTES);

      /* Нужен ВЫИГРАННЫЙ бой, стоивший игроку хотя бы единицы HP:
         на нетронутом здоровье формула верна тождественно. Условие
         мягкое (урон > 0, а не «урон больше доли восстановления»)
         именно потому, что жёсткое перестало выполняться: зона
         возвращает половину, а снаряжённый игрок столько в Пустошах
         не теряет. Что формула частичная, доказано выше — там, где
         это не зависит от броска. */
      let checked = false;
      for (let i = 0; i < raid.fightsPerRun && !checked; i++) {
        const result = await fight(jar);
        const remaining = result.outcome.hpRemaining[0];

        if (result.outcome.winner === 0 && remaining < result.run.maxHp) {
          /* Ожидаемое считается ИЗ ДАННЫХ ЗОНЫ, а не вызовом
             `healBetweenFights`. Через неё тест был тавтологией:
             диверсия «читать только общую долю» ломала обе стороны
             сравнения разом, и он проходил на сломанном сервере. */
          const byZone = (fraction: number): number =>
            Math.min(
              result.run.maxHp,
              Math.max(1, Math.round(remaining + result.run.maxHp * fraction)),
            );

          expect(result.run.hp).toBe(byZone(restore));
          checked = true;
        }

        if (result.run.state !== 'active') break;
      }

      expect(checked, 'ни один бой не стоил игроку HP — проверять нечего').toBe(true);
    });

    it('зелье тратит заряд и лечит, а без зарядов — отказ', async () => {
      const { jar } = await register(ctx);
      await gearUp(jar);
      const playerId = await playerIdOf(jar);
      await start(jar, 'wastes', 'nightmare');

      /* Игрока надо ПОРАНИТЬ: на полном здоровье зелье не отличается
         от бездействия, и тест ничего не докажет.

         Рана ставится прямой записью, а не подбором боя: исход боя
         случаен, и тест, который ждёт удачного расклада, — это тест,
         который однажды покраснеет без единой правки кода. Проверяется
         здесь зелье, а не бой; подготовка состояния законна ровно тем,
         что сам механизм зелья идёт обычным путём через эндпоинт. */
      const full = await runOf(jar);
      expect(full).not.toBeNull();
      await ctx.db.update(players).set({ hpCurrent: 1 }).where(eq(players.id, playerId));
      const hurt = await runOf(jar);

      expect(hurt?.state).toBe('active');
      expect(hurt?.hp, 'лечить нечего — тест не докажет ничего').toBeLessThan(hurt?.maxHp ?? 0);

      let potions = hurt?.potionsLeft ?? 0;
      let hp = hurt?.hp ?? 0;
      for (let i = 0; i < raid.potionChargesPerRun; i++) {
        const res = await post(ctx, API_ROUTES.runPotion, {}, jar);
        expect(res.status, `заряд ${i + 1}`).toBe(200);
        const run = (res.body as unknown as RunResponse).run;
        expect(run?.potionsLeft).toBe(potions - 1);
        // Лечит, а не просто тратит заряд. Строгое «больше» — пока
        // не упёрлись в максимум; дальше только «не меньше».
        if (hp < (run?.maxHp ?? 0)) expect(run?.hp ?? 0).toBeGreaterThan(hp);
        else expect(run?.hp ?? 0).toBe(hp);
        potions = run?.potionsLeft ?? 0;
        hp = run?.hp ?? 0;
      }

      // Четвёртого заряда нет — и это отказ, а не тихое ничего.
      expect((await post(ctx, API_ROUTES.runPotion, {}, jar)).status).toBe(409);
    });
  });

  describe('клиент не знает будущего', () => {
    it('в ответе нет сида забега ни в каком виде', async () => {
      const { jar } = await register(ctx);
      const run = await start(jar);

      /* С сидом можно было бы посчитать состав всех пяти боёв заранее,
         и решение «идти дальше» перестало бы быть ставкой. */
      const row = (await ctx.db.select().from(runs).where(eq(runs.id, run.runId)))[0];
      expect(row?.seed).toBeTruthy();

      const serialized = JSON.stringify(run);
      expect(serialized).not.toContain(row?.seed ?? 'нет-сида');
    });

    it('показан ТОЛЬКО следующий противник, а не весь список боёв', async () => {
      const { jar } = await register(ctx);
      const run = await start(jar);

      // Одно поле `next`, а не массив на пять боёв: §7.2 требует
      // «превью следующего врага», и ровно столько и отдаётся.
      expect(run.next).not.toBeNull();
      expect(Object.keys(run).filter((k) => k.includes('fights'))).toEqual(['fightsTotal']);
    });

    it('пятый бой — босс, и это видно заранее ровно на пятом', async () => {
      const { jar } = await register(ctx);
      await gearUp(jar);
      await start(jar);

      const seen: boolean[] = [];
      for (let i = 0; i < raid.fightsPerRun; i++) {
        const current = await runOf(jar);
        seen.push(current?.next?.boss ?? false);
        const result = await fight(jar);
        if (result.run.state !== 'active') break;
      }

      expect(seen.slice(0, 4)).toEqual([false, false, false, false]);
      expect(seen[4]).toBe(true);
    });
  });

  describe('пятый бой заканчивает забег', () => {
    it('выживший после босса получает сумку без отдельной эвакуации', async () => {
      const { jar } = await register(ctx);
      await gearUp(jar);
      await start(jar);

      let last: RunFightResponse | null = null;
      for (let i = 0; i < raid.fightsPerRun; i++) {
        last = await fight(jar);
        if (last.run.state !== 'active') break;
      }

      expect(last?.run.state).toBe('extracted');
      expect(last?.run.bag).toHaveLength(0);
      // Сумка не пропала — она в инвентаре.
      const inv = await inventory(jar);
      expect(inv.items.length).toBeGreaterThan(1);
      expect(await runOf(jar)).toBeNull();
    });

    it('множитель лута растёт с глубиной', async () => {
      const { jar } = await register(ctx);
      await gearUp(jar);
      const run = await start(jar);
      expect(run.lootMultiplier).toBe(raid.lootMultiplierByFight[0]);

      await fight(jar);
      await fight(jar);
      const deeper = await runOf(jar);

      // Иначе «идти дальше» не давало бы ничего, кроме риска.
      expect(deeper?.lootMultiplier ?? 0).toBeGreaterThan(run.lootMultiplier);
    });
  });
});
