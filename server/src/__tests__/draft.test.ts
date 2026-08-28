import { balance as balanceData } from '@extramundum/data';
import { CARDS } from '@extramundum/data/cards';
import {
  API_ROUTES,
  xpForLevel,
  type DraftResponse,
  type InventoryResponse,
  type ProgressionBalance,
} from '@extramundum/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { players } from '../db/schema/game.ts';
import { fighterFromLoadout } from '../items/loadout.ts';
import { loadoutOf } from '../items/repository.ts';
import { toProfile } from '../players/repository.ts';
import { progressionOf } from '../progression/service.ts';
import { playerCards, playerTraits } from '../db/schema/items.ts';

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
const progression = balanceData.progression as unknown as ProgressionBalance;

/**
 * Драфт уровня против настоящей базы. GDD §5.2.
 *
 * Проверяется не «показываются ли карточки», а то, ради чего драфт
 * написан именно так: ОФФЕР НЕЛЬЗЯ ПОДДЕЛАТЬ. Он нигде не хранится,
 * сервер пересчитывает его из сида при каждом обращении, и карта,
 * которой не предлагали, не находится — даже если прислать её напрямую,
 * минуя интерфейс.
 *
 * Второе, что здесь доказывается: выбранное ДОХОДИТ ДО БОЙЦА. Карта,
 * записанная в базу и не влияющая на статы, — это ровно баг v1.0
 * из §13 пункта 4 в новом месте.
 */
describe.skipIf(!HAS_DB)('драфт', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  /** Свежий изгнанный с проверенной сессией. */
  const newExile = async (): Promise<CookieJar> => {
    const { jar, status } = await register(ctx);
    expect(status).toBe(200);
    return jar;
  };

  const messageKeyOf = (body: unknown): string | undefined =>
    (body as { error?: { messageKey?: string } }).error?.messageKey;

  const playerIdOf = async (jar: CookieJar): Promise<string> => {
    const me = await get(ctx, API_ROUTES.me, jar);
    return (me.body as { player: { id: string } }).player.id;
  };

  /** Выдать опыт напрямую в базу: бои здесь ни при чём, проверяется драфт. */
  const grantXpForLevel = async (jar: CookieJar, level: number): Promise<string> => {
    const playerId = await playerIdOf(jar);
    await ctx.db
      .update(players)
      .set({ xp: xpForLevel(level, progression) })
      .where(eq(players.id, playerId));
    return playerId;
  };

  const draft = async (jar: CookieJar): Promise<DraftResponse> => {
    const res = await get(ctx, API_ROUTES.draft, jar);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as unknown as DraftResponse;
  };

  const pick = async (jar: CookieJar, choice: string) =>
    post(ctx, API_ROUTES.draftPick, { choice }, jar);

  const inventory = async (jar: CookieJar): Promise<InventoryResponse> => {
    const res = await get(ctx, API_ROUTES.items, jar);
    expect(res.status).toBe(200);
    return res.body as unknown as InventoryResponse;
  };

  describe('доступ', () => {
    it('без сессии оба маршрута отвечают 401', async () => {
      expect((await get(ctx, API_ROUTES.draft)).status).toBe(401);
      expect((await post(ctx, API_ROUTES.draftPick, { choice: 'atk.blade' })).status).toBe(401);
    });
  });

  describe('оффер', () => {
    it('свежему изгнанному разбирать нечего', async () => {
      const jar = await newExile();
      const { draft: view, progress } = await draft(jar);

      expect(view.level).toBeNull();
      expect(view.pending).toBe(0);
      expect(view.options).toEqual([]);
      expect(progress.level).toBe(1);
      expect(progress.xpForNext).toBe(xpForLevel(2, progression));
    });

    it('с опытом на второй уровень предлагается три карты', async () => {
      const jar = await newExile();
      await grantXpForLevel(jar, 2);
      const { draft: view } = await draft(jar);

      expect(view.level).toBe(2);
      expect(view.kind).toBe('card');
      expect(view.options).toHaveLength(progression.levelUpCardCount);
      // Три РАЗНЫЕ карты: повтор внутри оффера означал бы выбор из двух.
      expect(new Set(view.options.map((o) => o.id)).size).toBe(view.options.length);
    });

    it('оффер не меняется между запросами: он выводится, а не бросается', async () => {
      const jar = await newExile();
      await grantXpForLevel(jar, 2);

      const first = (await draft(jar)).draft.options.map((o) => o.id);
      const second = (await draft(jar)).draft.options.map((o) => o.id);
      expect(second).toEqual(first);
    });

    it('накопленные уровни разбираются по одному', async () => {
      const jar = await newExile();
      await grantXpForLevel(jar, 4);

      const { draft: view } = await draft(jar);
      expect(view.level).toBe(2);
      expect(view.pending).toBe(3);
    });
  });

  describe('подделка', () => {
    it('карта, которой не предлагали, отвергается — а предложенная проходит', async () => {
      const jar = await newExile();
      await grantXpForLevel(jar, 2);

      const offered = (await draft(jar)).draft.options.map((o) => o.id);
      const notOffered = CARDS.map((c) => c.id).find((id) => !offered.includes(id));
      expect(notOffered, 'вся колода попала в оффер — тест ничего не проверит').toBeDefined();

      const denied = await pick(jar, notOffered!);
      expect(denied.status).toBe(403);
      expect(messageKeyOf(denied.body)).toBe('error.draft.notOffered');

      /* ВТОРАЯ ПОЛОВИНА ОБЯЗАТЕЛЬНА. Без неё тест прошёл бы и на сервере,
         который отвергает вообще всё: «не предлагали» и «сломано»
         выглядят одинаково. */
      const allowed = await pick(jar, offered[0]!);
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    });

    it('несуществующая карта отвергается так же, как чужая', async () => {
      const jar = await newExile();
      await grantXpForLevel(jar, 2);
      const res = await pick(jar, 'atk.нет-такой');
      expect(res.status).toBe(403);
    });

    it('без накопленного уровня выбор отвергается', async () => {
      const jar = await newExile();
      const res = await pick(jar, 'atk.blade');
      expect(res.status).toBe(409);
      expect(messageKeyOf(res.body)).toBe('error.draft.nothingPending');
    });

    it('один уровень нельзя разобрать дважды', async () => {
      const jar = await newExile();
      const playerId = await grantXpForLevel(jar, 2);

      const offered = (await draft(jar)).draft.options.map((o) => o.id);
      expect((await pick(jar, offered[0]!)).status).toBe(200);
      // Второй раз тот же уровень не разбирается: уровень уже поднят,
      // и разбирать нечего.
      expect((await pick(jar, offered[0]!)).status).toBe(409);

      const rows = await ctx.db
        .select()
        .from(playerCards)
        .where(eq(playerCards.playerId, playerId));
      expect(rows).toHaveLength(1);
    });
  });

  describe('применение', () => {
    it('выбор поднимает уровень и записывается', async () => {
      const jar = await newExile();
      const playerId = await grantXpForLevel(jar, 2);

      const offered = (await draft(jar)).draft.options.map((o) => o.id);
      const res = await pick(jar, offered[0]!);
      expect(res.status).toBe(200);

      const body = res.body as unknown as DraftResponse;
      expect(body.progress.level).toBe(2);
      // Ответ несёт СЛЕДУЮЩИЙ оффер, а не «ок»: разбирать больше нечего.
      expect(body.draft.level).toBeNull();

      const row = (await ctx.db.select().from(players).where(eq(players.id, playerId)))[0];
      expect(row?.level).toBe(2);
      const cards = await ctx.db
        .select()
        .from(playerCards)
        .where(eq(playerCards.playerId, playerId));
      expect(cards.map((c) => c.cardId)).toEqual([offered[0]]);
    });

    it('взятые карты ДОХОДЯТ ДО БОЙЦА, а не только до базы', async () => {
      const jar = await newExile();
      await grantXpForLevel(jar, progression.levelCap);

      const before = (await inventory(jar)).stats;

      /* Мерятся ЧЕТЫРЕ канала сразу: ATK, скорость, броня и точность.
         Одного мало — диверсия, стирающая карты из ATK, прошла бы
         незамеченной в тот прогон, где взятая карта давала броню.
         Поэтому уровни разбираются до тех пор, пока не набран хотя бы
         один вклад в КАЖДЫЙ из четырёх.

         Сид при этом не подбирается: от его значения зависит весь оффер,
         и подобранный сид мерил бы удачу вместо механики. */
      const KEYS = ['atk', 'spd', 'armor', 'accuracy'] as const;
      const cards: Record<(typeof KEYS)[number], number> = {
        atk: 0,
        spd: 0,
        armor: 0,
        accuracy: 0,
      };
      const got = new Set<(typeof KEYS)[number]>();

      let levels = 0;
      let view = (await draft(jar)).draft;

      while (view.level !== null && got.size < KEYS.length) {
        const wanted = (o: (typeof view.options)[number]): boolean =>
          KEYS.some((k) => !got.has(k) && (o.effects[k] ?? 0) > 0);
        const choice =
          (view.kind === 'card' ? view.options.find(wanted) : undefined) ?? view.options[0]!;

        for (const key of KEYS) {
          const value = choice.effects[key] ?? 0;
          cards[key] += value;
          if (value > 0) got.add(key);
        }
        levels += 1;

        const res = await pick(jar, choice.id);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        view = (res.body as unknown as DraftResponse).draft;
      }

      /* ПРОВЕРКА, ЧТО ПРОВЕРЯТЬ ЕСТЬ ЧТО. Без неё равенства ниже сошлись
         бы на одном автоприросте за уровень — то есть тест зеленел бы
         на сервере, который карты записывает и не применяет. */
      expect([...got].sort(), 'не все четыре канала измерены').toEqual([...KEYS].sort());

      const after = (await inventory(jar)).stats;
      const auto = levels * progression.statPerLevel;

      // РАВЕНСТВА, а не «стало больше»: «больше» верно и от одного
      // автоприроста, то есть при полностью потерянных картах.
      expect(after.atk).toBe(before.atk + auto + cards.atk);
      expect(after.spd).toBe(before.spd + auto + cards.spd);
      expect(after.armor).toBe(before.armor + cards.armor);
      expect(after.accuracy).toBe(before.accuracy + cards.accuracy);
    });

    it('каждый пятый уровень предлагает трейты, а не карты', async () => {
      const jar = await newExile();
      const playerId = await grantXpForLevel(jar, 5);

      let view = (await draft(jar)).draft;
      while (view.level !== null && view.level < 5) {
        const res = await pick(jar, view.options[0]!.id);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        view = (res.body as unknown as DraftResponse).draft;
      }

      expect(view.level).toBe(5);
      expect(view.kind).toBe('trait');
      expect(view.options).toHaveLength(progression.levelUpCardCount);
      // Гарантированно, а не «60% шанс», как было в v1.0.
      expect(view.options.every((o) => o.lean === null)).toBe(true);

      const res = await pick(jar, view.options[0]!.id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const chosen = view.options[0]!.id;
      const traits = await ctx.db
        .select()
        .from(playerTraits)
        .where(eq(playerTraits.playerId, playerId));
      expect(traits.map((t) => t.traitId)).toEqual([chosen]);

      /* И ТРЕЙТ ТОЖЕ ОБЯЗАН ДОЙТИ ДО БОЙЦА. Запись в базе сама по себе
         ничего не значит: до M3c здесь стоял пустой список, и реестр
         трейтов работал только на монстрах. Путь берётся ПРОИЗВОДСТВЕННЫЙ,
         тот же, которым собирается боец боя, — иначе проверялся бы
         не он. */
      const row = (await ctx.db.select().from(players).where(eq(players.id, playerId)))[0]!;
      const profile = toProfile(row);
      const bonuses = await progressionOf(ctx.db, profile);
      expect(bonuses.traits).toContain(chosen);

      const config = fighterFromLoadout(profile, await loadoutOf(ctx.db, playerId), bonuses);
      expect(config.traits).toContain(chosen);
    });
  });
});
