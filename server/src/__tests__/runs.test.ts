import { balance as balanceData, ITEM_BASES } from '@extramundum/data';
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
      expect(wastes.difficulties.nightmare.enemyLevel).toBeGreaterThan(
        wastes.difficulties.normal.enemyLevel,
      );
      // Множитель матчапа тоже готовым числом (§4.3, «ничего не спрятано»).
      expect(typeof wastes.matchup).toBe('number');
      expect(body.activeRun).toBeNull();
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

  describe('сумка и эвакуация', () => {
    it('лут падает В СУМКУ, а не в инвентарь', async () => {
      const { jar } = await register(ctx);
      await gearUp(jar);
      const before = await inventory(jar);
      await start(jar);

      const result = await fight(jar);
      expect(result.run.bag.length).toBeGreaterThan(0);

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
      await start(jar);
      await fight(jar);
      const second = await fight(jar);

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
     * Игрок первого уровня в Чумных ямах на кошмаре встречает врага
     * 32 уровня: `clamp(1 + 5, 32, 40)`. Это гарантированная смерть —
     * и ровно тот случай, о котором §7.3 говорит «враг МОЖЕТ быть
     * сильнее игрока, и это выбор игрока».
     */
    const suicide = async (jar: CookieJar) => {
      await start(jar, 'abyss', 'nightmare');
      return fight(jar);
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
      await start(jar);
      await fight(jar);
      const before = await fight(jar);

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
    it('HP переносится между боями и добирается ровно на четверть', async () => {
      const { jar } = await register(ctx);
      await gearUp(jar);
      /* Сложность «опасно» взята НЕ ради суровости: игрок первого уровня
         в комплекте под восьмой заметно выше тира, и на нормале он может
         не получить ни одного удара за весь забег. */
      await start(jar, 'wastes', 'dangerous');

      /* Нужен ВЫИГРАННЫЙ бой, который стоил игроку HP. На полном
         здоровье формула «остаток плюс четверть» верна тождественно
         и не доказывает ничего, а на проигранном HP обнуляется
         по другому правилу. Поэтому — до первого подходящего боя,
         и отдельная проверка, что он вообще случился. */
      let checked = false;
      for (let i = 0; i < raid.fightsPerRun && !checked; i++) {
        const result = await fight(jar);
        const remaining = result.outcome.hpRemaining[0];
        const maxHp = result.run.maxHp;

        /* Нужен бой, где урон ПРЕВЫСИЛ четверть максимума: иначе
           восстановление добьёт до полного, и «не полностью» из §7.2
           проверять будет не на чем. */
        if (result.outcome.winner === 0 && remaining < maxHp * (1 - raid.hpRestoreBetweenFights)) {
          // Ровно формула §7.2: остаток плюс четверть максимума, но
          // не выше максимума. Не «примерно меньше» — точное число.
          const expected = Math.min(
            maxHp,
            Math.max(1, Math.round(remaining + maxHp * raid.hpRestoreBetweenFights)),
          );
          expect(result.run.hp).toBe(expected);
          expect(result.run.hp).toBeLessThan(maxHp);
          checked = true;
        }

        if (result.run.state !== 'active') break;
      }

      expect(checked, 'ни один бой не стоил игроку HP — проверять нечего').toBe(true);
    });

    it('зелье тратит заряд и лечит, а без зарядов — отказ', async () => {
      const { jar } = await register(ctx);
      await gearUp(jar);
      await start(jar, 'wastes', 'dangerous');

      /* Игрока надо ПОРАНИТЬ: на полном здоровье зелье не отличается
         от бездействия, и тест ничего не докажет. Бои идут до первого
         подходящего состояния. */
      let hurt = await runOf(jar);
      for (let i = 0; i < raid.fightsPerRun; i++) {
        const result = await fight(jar);
        hurt = result.run;
        if (result.run.state !== 'active') break;
        if (result.run.hp < result.run.maxHp) break;
      }

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
