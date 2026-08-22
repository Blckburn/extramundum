import { API_ROUTES } from '@extramundum/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { players } from '../db/schema/game.ts';
import { ensurePlayer, findPlayerByUserId } from '../players/repository.ts';
import {
  CookieJar,
  createTestContext,
  databaseUrl,
  get,
  post,
  register,
  unique,
  type TestContext,
} from './helpers.ts';

const HAS_DB = databaseUrl() !== undefined;
const LOADOUT = 'a'.repeat(64);

/**
 * Интеграционные тесты HTTP-слоя.
 *
 * Инвариант 4 говорит: механики без теста не существует. Регистрация —
 * механика, и до этих тестов её защищала только ручная проверка,
 * то есть ничего.
 */

// Без базы тесты пропускаются, но в CI это недопустимо: молча
// пропущенный тест — это тест, которого нет.
it('в CI база обязана быть доступна', () => {
  if (process.env['CI'] === 'true') {
    expect(HAS_DB, 'DATABASE_URL не задан в CI').toBe(true);
  }
});

describe.skipIf(!HAS_DB)('API', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  describe('health', () => {
    it('отвечает ok, когда БД доступна', async () => {
      const { status, body } = await get(ctx, API_ROUTES.health);
      expect(status).toBe(200);
      expect(body).toEqual({ status: 'ok', database: 'up' });
    });
  });

  describe('регистрация', () => {
    it('создаёт строку в players со стартовыми значениями', async () => {
      const { status, username } = await register(ctx);
      expect(status).toBe(200);

      const rows = await ctx.db.select().from(players).where(eq(players.username, username));
      expect(rows).toHaveLength(1);

      const row = rows[0]!;
      expect(row.level).toBe(1);
      expect(row.xp).toBe(0);
      expect(row.gold).toBe(0);
      expect(row.paragonPoints).toBe(0);
      expect(row.elo).toBe(1000);
      expect(row.seasonId).toBeNull();
      // Номер выдаёт последовательность в БД: он есть и он положительный.
      expect(row.exileNumber).toBeGreaterThan(0);
    });

    it('отклоняет занятое имя без учёта регистра', async () => {
      const first = await register(ctx, { username: `Гром${unique()}` });
      expect(first.status).toBe(200);

      const second = await register(ctx, { username: first.username.toUpperCase() });

      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({
        error: {
          code: 'conflict',
          messageKey: 'error.field.username.taken',
          fields: { username: 'error.field.username.taken' },
        },
      });
    });

    it('отклоняет занятую почту', async () => {
      const first = await register(ctx);
      expect(first.status).toBe(200);

      const second = await register(ctx, { email: first.email });
      expect(second.status).toBeGreaterThanOrEqual(400);

      // Учётная запись не задвоилась.
      const count = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(players)
        .where(eq(players.username, first.username));
      expect(count[0]!.n).toBe(1);
    });

    it('на кривой ввод отдаёт ключи локали, а не текст zod', async () => {
      const { status, body } = await post(ctx, '/auth/register', {
        email: 'не почта',
        password: '123',
        username: 'ой!',
      });

      expect(status).toBe(400);
      expect(body).toMatchObject({
        error: {
          code: 'validation_failed',
          messageKey: 'error.validation_failed',
          fields: {
            email: 'error.field.email.invalid',
            password: 'error.field.password.tooShort',
            username: 'error.field.username.invalid',
          },
        },
      });

      // Ни одна строка ответа не должна быть английским текстом библиотеки.
      expect(JSON.stringify(body)).not.toMatch(/Invalid|Too small|expected/);
    });

    it('не является JSON — 400, а не 500', async () => {
      const response = await ctx.app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'не json',
      });
      expect(response.status).toBe(400);
    });
  });

  describe('GET /me', () => {
    it('без сессии отдаёт 401 в конверте ApiError', async () => {
      const { status, body } = await get(ctx, API_ROUTES.me);

      expect(status).toBe(401);
      expect(body).toMatchObject({
        error: { code: 'unauthorized', messageKey: 'error.unauthorized' },
      });
      expect((body as { error: { requestId: string } }).error.requestId).toBeTruthy();
    });

    it('с сессией отдаёт профиль, прочитанный из БД', async () => {
      const { jar, username } = await register(ctx);
      const { status, body } = await get(ctx, API_ROUTES.me, jar);

      expect(status).toBe(200);
      const player = (body as { player: Record<string, unknown> }).player;
      expect(player.username).toBe(username);
      expect(player.level).toBe(1);
      expect(player.gold).toBe(0);
    });

    it('после выхода сессия больше не действует', async () => {
      const { jar } = await register(ctx);
      expect((await get(ctx, API_ROUTES.me, jar)).status).toBe(200);

      await post(ctx, `${API_ROUTES.auth}/sign-out`, {}, jar);

      expect((await get(ctx, API_ROUTES.me, jar)).status).toBe(401);
    });

    it('вход по почте и паролю восстанавливает доступ', async () => {
      const { email, username } = await register(ctx);

      const jar = new CookieJar();
      const signIn = await post(
        ctx,
        `${API_ROUTES.auth}/sign-in/email`,
        { email, password: 'correct-horse-battery' },
        jar,
      );
      expect(signIn.status).toBe(200);

      const me = await get(ctx, API_ROUTES.me, jar);
      expect(me.status).toBe(200);
      expect((me.body as { player: { username: string } }).player.username).toBe(username);
    });
  });

  /**
   * Инвариант 1 — центральный урок v1.0. В той версии золото и предметы
   * правились из devtools, потому что клиент присылал состояние, а сервер
   * его записывал. Эти тесты проверяют, что путь закрыт.
   */
  describe('инвариант 1: клиент не может изменить своё состояние', () => {
    it('лишние поля в теле запроса игнорируются, а не записываются', async () => {
      const { jar, username } = await register(ctx);
      const before = await ctx.db.select().from(players).where(eq(players.username, username));
      const numberBefore = before[0]!.exileNumber;

      await post(
        ctx,
        API_ROUTES.battleStart,
        {
          zone: 'wastes',
          difficulty: 'normal',
          loadoutHash: LOADOUT,
          // Ровно то, чем правили состояние в v1.0.
          gold: 999_999,
          level: 40,
          xp: 1_000_000,
          elo: 9999,
          exileNumber: 1,
        },
        jar,
      );

      const rows = await ctx.db.select().from(players).where(eq(players.username, username));
      const row = rows[0]!;

      expect(row.gold).toBe(0);
      expect(row.level).toBe(1);
      expect(row.xp).toBe(0);
      expect(row.elo).toBe(1000);
      expect(row.exileNumber).toBe(numberBefore);
    });

    it('регистрация не даёт задать себе стартовые статы', async () => {
      const suffix = unique();
      const username = `Читер${suffix}`;

      await post(ctx, '/auth/register', {
        email: `cheat-${suffix}@example.com`,
        password: 'correct-horse-battery',
        username,
        gold: 500_000,
        level: 40,
        statAtk: 999,
      });

      const rows = await ctx.db.select().from(players).where(eq(players.username, username));
      const row = rows[0]!;

      expect(row.gold).toBe(0);
      expect(row.level).toBe(1);
      expect(row.statAtk).toBe(5);
    });

    it('профиль читается по сессии, а не по идентификатору из запроса', async () => {
      const alice = await register(ctx);
      const bob = await register(ctx);

      const bobRow = await findPlayerByUserId(
        ctx.db,
        (await ctx.db.select().from(players).where(eq(players.username, bob.username)))[0]!.userId,
      );
      expect(bobRow).not.toBeNull();

      // Алиса пытается запросить чужой профиль всеми доступными способами.
      for (const path of [
        `${API_ROUTES.me}?playerId=${bobRow!.id}`,
        `${API_ROUTES.me}?userId=${bobRow!.id}`,
        `${API_ROUTES.me}?username=${encodeURIComponent(bob.username)}`,
      ]) {
        const { status, body } = await get(ctx, path, alice.jar);
        expect(status).toBe(200);
        // Всегда её собственный профиль: параметры запроса ни на что не влияют.
        expect((body as { player: { username: string } }).player.username).toBe(alice.username);
      }
    });
  });

  /**
   * Номера изгнанных. LORE §2, GDD §1.
   *
   * Номер — не украшение: по нему видно, кто снаружи давно. Значит он
   * обязан быть уникальным, монотонным и невыдаваемым дважды.
   */
  describe('номер изгнанного', () => {
    it('выдаётся при регистрации и растёт', async () => {
      const first = await register(ctx);
      const second = await register(ctx);

      const rows = await ctx.db
        .select()
        .from(players)
        .where(inArray(players.username, [first.username, second.username]));

      const a = rows.find((r) => r.username === first.username)!;
      const b = rows.find((r) => r.username === second.username)!;

      expect(a.exileNumber).toBeGreaterThan(0);
      expect(b.exileNumber).toBeGreaterThan(a.exileNumber);
    });

    it('одинаковых номеров не бывает', async () => {
      const all = await ctx.db.select({ n: players.exileNumber }).from(players);
      const unique = new Set(all.map((r) => r.n));
      expect(unique.size).toBe(all.length);
    });

    it('одновременные регистрации получают разные номера', async () => {
      // Ради этого номер выдаёт последовательность в БД, а не SELECT MAX + 1:
      // при параллельных вставках второй вариант выдал бы дубль.
      const registered = await Promise.all([
        register(ctx),
        register(ctx),
        register(ctx),
        register(ctx),
        register(ctx),
      ]);
      const names = registered.map((r) => r.username);

      const rows = await ctx.db.select().from(players).where(inArray(players.username, names));

      const numbers = rows.map((r) => r.exileNumber);
      expect(rows).toHaveLength(names.length);
      expect(new Set(numbers).size).toBe(numbers.length);
    });

    it('отдаётся клиенту в профиле', async () => {
      const { jar } = await register(ctx);
      const { body } = await get(ctx, API_ROUTES.me, jar);
      const player = (body as { player: { exileNumber: number } }).player;
      expect(player.exileNumber).toBeGreaterThan(0);
    });
  });

  describe('battle/start', () => {
    const body = { zone: 'wastes', difficulty: 'normal', loadoutHash: LOADOUT } as const;

    it('без сессии — 401', async () => {
      expect((await post(ctx, API_ROUTES.battleStart, body)).status).toBe(401);
    });

    it('с сессией — проводит бой и возвращает лог', async () => {
      // До M2b здесь стоял 501. Тест не обновили вместе с эндпоинтом,
      // и это осталось незамеченным ровно потому, что интеграционные
      // тесты без DATABASE_URL пропускаются: локально «всё зелено»,
      // а в CI с базой — красно. Тот самый случай, ради которого
      // в CI стоит CI=true.
      const { jar } = await register(ctx);
      const res = await post(ctx, API_ROUTES.battleStart, body, jar);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        provisional: true,
        rewards: {},
        outcome: { winner: expect.anything() },
      });

      const parsed = res.body as {
        log: { events: unknown[]; seed: string };
        maxHp: [number, number];
      };
      expect(parsed.log.events.length).toBeGreaterThan(0);
      expect(parsed.log.seed).toEqual(expect.any(String));
      // Максимум HP присылает СЕРВЕР: вывести его из лога нельзя.
      expect(parsed.maxHp[0]).toBeGreaterThan(0);
      expect(parsed.maxHp[1]).toBeGreaterThan(0);
    });

    it('валидирует тело до того, как проводить бой', async () => {
      const { jar } = await register(ctx);
      const res = await post(
        ctx,
        API_ROUTES.battleStart,
        { zone: 'нет такой зоны', difficulty: 'normal' },
        jar,
      );

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: 'validation_failed' } });
    });
  });

  /**
   * Вертикальный срез M1a: от HTTP до формул движка.
   *
   * Отдельная ценность этих тестов — они проходят через настоящую
   * сессию и настоящую БД. Движок покрыт своими тестами; здесь
   * проверяется, что между запросом и движком ничего не потерялось
   * и что клиент не может подсунуть свои статы.
   */
  describe('simulate/preview', () => {
    const body = { zone: 'wastes', difficulty: 'normal', loadoutHash: LOADOUT } as const;

    it('без сессии — 401', async () => {
      expect((await post(ctx, API_ROUTES.simulatePreview, body)).status).toBe(401);
    });

    it('возвращает осмысленную оценку', async () => {
      const { jar } = await register(ctx);
      const res = await post(ctx, API_ROUTES.simulatePreview, { ...body, runs: 100 }, jar);

      expect(res.status).toBe(200);
      const payload = res.body as { winRate: number; runs: number; basis: string };

      expect(payload.runs).toBe(100);
      expect(payload.winRate).toBeGreaterThanOrEqual(0);
      expect(payload.winRate).toBeLessThanOrEqual(1);
      // Соперник помечен честно: зонных врагов ещё нет (M3).
      expect(payload.basis).toBe('sparring-dummy');
    });

    it('одинаковый запрос даёт одинаковый ответ', async () => {
      const { jar } = await register(ctx);
      const first = await post(ctx, API_ROUTES.simulatePreview, { ...body, runs: 60 }, jar);
      const second = await post(ctx, API_ROUTES.simulatePreview, { ...body, runs: 60 }, jar);

      // Иначе игрок, дважды посмотревший на один предмет, увидит два
      // разных числа и перестанет верить обоим (GDD §6.4).
      expect((second.body as { winRate: number }).winRate).toBe(
        (first.body as { winRate: number }).winRate,
      );
    });

    it('сложность влияет на оценку', async () => {
      const { jar } = await register(ctx);
      const normal = await post(
        ctx,
        API_ROUTES.simulatePreview,
        { ...body, difficulty: 'normal', runs: 120 },
        jar,
      );
      const nightmare = await post(
        ctx,
        API_ROUTES.simulatePreview,
        { ...body, difficulty: 'nightmare', runs: 120 },
        jar,
      );

      const easy = (normal.body as { winRate: number }).winRate;
      const hard = (nightmare.body as { winRate: number }).winRate;

      // Кошмар даёт противнику +5 уровней (balance.raid.difficulty).
      // Если сложность не влияет — числа совпадут, и превью бесполезно.
      expect(hard).toBeLessThanOrEqual(easy);
      expect(easy - hard).toBeGreaterThan(0);
    });

    it('инвариант 1: статы бойца в теле запроса игнорируются', async () => {
      const { jar } = await register(ctx);

      const honest = await post(ctx, API_ROUTES.simulatePreview, { ...body, runs: 80 }, jar);
      const cheated = await post(
        ctx,
        API_ROUTES.simulatePreview,
        {
          ...body,
          runs: 80,
          // Схема таких полей не содержит — они обязаны быть отброшены,
          // а не подмешаны в бойца.
          atk: 9999,
          level: 40,
          statAtk: 9999,
          player: { atk: 9999, armor: 9999 },
        },
        jar,
      );

      expect(cheated.status).toBe(200);
      expect((cheated.body as { winRate: number }).winRate).toBe(
        (honest.body as { winRate: number }).winRate,
      );
    });

    it('укладывается в бюджет ответа GDD §6.4: 300 прогонов быстрее 500 мс', async () => {
      const { jar } = await register(ctx);

      const started = performance.now();
      const res = await post(ctx, API_ROUTES.simulatePreview, { ...body, runs: 300 }, jar);
      const elapsed = performance.now() - started;

      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(500);
    });

    it('валидирует тело', async () => {
      const { jar } = await register(ctx);
      const res = await post(
        ctx,
        API_ROUTES.simulatePreview,
        { zone: 'нет такой зоны', difficulty: 'normal' },
        jar,
      );

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: 'validation_failed' } });
    });
  });

  describe('прочее', () => {
    it('несуществующий маршрут — 404 в общем конверте', async () => {
      const { status, body } = await get(ctx, '/такого-нет');
      expect(status).toBe(404);
      expect(body).toMatchObject({ error: { code: 'not_found' } });
    });

    it('ensurePlayer идемпотентен', async () => {
      const { username } = await register(ctx);
      const rows = await ctx.db.select().from(players).where(eq(players.username, username));
      const { userId } = rows[0]!;

      // Хук уже создал профиль; повторные вызовы не должны ни падать,
      // ни плодить строки. На этом держится страховка в GET /me.
      await ensurePlayer(ctx.db, { userId, username });
      await ensurePlayer(ctx.db, { userId, username });

      const after = await ctx.db.select().from(players).where(eq(players.userId, userId));
      expect(after).toHaveLength(1);
    });

    it('в ответе есть сквозной идентификатор запроса', async () => {
      const response = await ctx.app.request(API_ROUTES.health);
      expect(response.headers.get('x-request-id')).toBeTruthy();
    });
  });
});
