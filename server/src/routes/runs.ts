import { balance as balanceData } from '@extramundum/data';
import { ZONES } from '@extramundum/data/zones';
import {
  API_ROUTES,
  DIFFICULTIES,
  emptyInputSchema,
  runStartInputSchema,
  type RunExtractResponse,
  type RunFightResponse,
  type RunResponse,
  type RunView,
  type ZoneCard,
  type ZonesResponse,
} from '@extramundum/shared';
import { matchupMultiplier } from '@extramundum/sim';
import { Hono, type Context } from 'hono';

import { requireSession } from '../auth/session.ts';
import { monsterLevel } from '../battle/monsters.ts';
import { combatBalance } from '../battle/setup.ts';
import type { Database } from '../db/client.ts';
import { AppError } from '../http/errors.ts';
import { fighterFromLoadout } from '../items/loadout.ts';
import { loadoutOf } from '../items/repository.ts';
import { findPlayerByUserId } from '../players/repository.ts';
import { findActiveRun } from '../runs/repository.ts';
import { drinkPotion, extract, fight, runView, startRun } from '../runs/service.ts';
import { parseBody, type AppEnv } from '../http/middleware.ts';

/**
 * Забег с эвакуацией. GDD §7.2, §7.3, §7.4.
 *
 * Ни один обработчик не принимает состояние игрока из тела запроса.
 * У боя, зелья и эвакуации тела нет вовсе: чей забег — из сессии,
 * какой бой следующий — из базы. Принимать номер боя от клиента значило
 * бы дать ему выбрать, какой бой провести, — то есть переиграть смерть.
 */
export function runRoutes(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * Профиль по проверенной сессии. Инвариант 1: идентификатор игрока
   * не приходит из запроса ни одним способом.
   */
  const profileOf = async (c: Context<AppEnv>) => {
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

  /**
   * GET /zones — что доступно на входе. GDD §7.3, §7.4.
   *
   * Уровень врага и множитель матчапа считает СЕРВЕР: формула §7.3
   * с ограничением диапазоном зоны живёт в одном месте, и клиенту
   * незачем её знать. «Ничего не спрятано» (§4.3) означает показать
   * готовое число, а не дать клиенту его вывести.
   */
  app.get(API_ROUTES.zones, async (c) => {
    const profile = await profileOf(c);
    const loadout = await loadoutOf(db, profile.id);
    const weapon = fighterFromLoadout(profile, loadout).weapon.class;

    const zones: ZoneCard[] = ZONES.map((zone) => {
      const difficulties = Object.fromEntries(
        DIFFICULTIES.map((key) => [
          key,
          {
            enemyLevel: monsterLevel(profile.level, zone, key),
            lootMultiplier: balanceData.raid.difficulty[key].lootMultiplier,
          },
        ]),
      ) as ZoneCard['difficulties'];

      return {
        id: zone.id,
        levels: zone.levels,
        armorClass: zone.armorClass,
        difficulties,
        monsters: zone.monsters,
        boss: zone.boss,
        // Смешанная зона одного числа не имеет — и не должна его
        // придумывать: там матчап у каждого свой (§7.4).
        matchup:
          zone.armorClass === 'mixed'
            ? null
            : matchupMultiplier(weapon, zone.armorClass, combatBalance),
      };
    });

    const active = await findActiveRun(db, profile.id);
    const body: ZonesResponse = {
      zones,
      activeRun: active === null ? null : await runView(db, { profile, row: active }),
    };
    return c.json(body);
  });

  /** GET /run — текущий забег или его отсутствие. */
  app.get(API_ROUTES.run, async (c) => {
    const profile = await profileOf(c);
    const active = await findActiveRun(db, profile.id);
    const body: RunResponse = {
      run: active === null ? null : await runView(db, { profile, row: active }),
    };
    return c.json(body);
  });

  app.post(API_ROUTES.runStart, async (c) => {
    const profile = await profileOf(c);
    const input = await parseBody(c, runStartInputSchema);
    const run = await startRun(db, profile, input);

    c.get('log').info('забег начат', {
      runId: run.runId,
      zone: input.zone,
      difficulty: input.difficulty,
    });
    const body: RunResponse = { run };
    return c.json(body);
  });

  /**
   * POST /run/fight — провести следующий бой.
   *
   * Клиент не говорит, какой бой: номер берётся из базы. Повторный
   * запрос не найдёт забег в ожидаемом состоянии — награда не начислится
   * дважды, и смерть не переиграется.
   */
  app.post(API_ROUTES.runFight, async (c) => {
    const profile = await profileOf(c);
    await parseBody(c, emptyInputSchema);
    const result = await fight(db, profile);

    c.get('log').info('бой забега проведён', {
      runId: result.run.runId,
      fightIndex: result.run.fightIndex,
      enemy: result.enemy,
      enemyLook: result.enemyLook,
      state: result.run.state,
      xp: result.rewards.xp,
      gold: result.rewards.gold,
      drops: result.rewards.loot.length,
    });

    const body: RunFightResponse = {
      battleId: result.battleId,
      log: result.log,
      outcome: result.outcome,
      maxHp: result.maxHp,
      enemy: result.enemy,
      enemyLook: result.enemyLook,
      rewards: result.rewards,
      run: result.run,
    };
    return c.json(body);
  });

  app.post(API_ROUTES.runPotion, async (c) => {
    const profile = await profileOf(c);
    await parseBody(c, emptyInputSchema);
    const run: RunView = await drinkPotion(db, profile);
    const body: RunResponse = { run };
    return c.json(body);
  });

  app.post(API_ROUTES.runExtract, async (c) => {
    const profile = await profileOf(c);
    await parseBody(c, emptyInputSchema);
    const { run, recovered } = await extract(db, profile);

    c.get('log').info('эвакуация', { runId: run.runId, recovered });
    const body: RunExtractResponse = { run, recovered };
    return c.json(body);
  });

  return app;
}
