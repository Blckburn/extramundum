import { monsterSpec, zoneSpec } from '@extramundum/data';
import type { BattleSetup, Difficulty, PlayerProfile, ZoneId } from '@extramundum/shared';
import { resolveBattle } from '@extramundum/sim';

import { fighterFromLoadout, type Loadout } from '../items/loadout.ts';

import { monsterFighter, monsterLevel } from './monsters.ts';
import { combatBalance, sparringDummy } from './setup.ts';

/**
 * Оценка шанса победы. GDD §6.4.
 *
 * «В автобаттлере игрок не может сыграть лучше, поэтому вопрос
 * "стало ли лучше?" должен получать честный численный ответ.»
 *
 * Метод — Монте-Карло: N боёв на разных сидах, доля побед. Состояние
 * не меняется, награды не выдаются, в БД ничего не пишется.
 *
 * ПРОТИВНИКИ БЕРУТСЯ ИЗ ЗОНЫ (M3b). До этого здесь стоял спарринг-манекен,
 * и на снаряжённом персонаже превью упиралось в потолок: 100% → 100%,
 * то есть переставало отвечать на вопрос §6.4 ровно там, где вопрос
 * и возникает. Манекен остался только для зон, которых ещё нет.
 *
 * Прогоны раскладываются ПОРОВНУ по обычным монстрам зоны, а не по
 * одному представителю: зона — это набор матчапов, и «шанс победы
 * в Катакомбах» обязан учитывать всех, кого там встретишь. Босс в счёт
 * не идёт: он пятый бой, а не типичный противник, и смешивать его
 * с рядовыми значило бы занижать оценку первых четырёх боёв.
 */

/**
 * Сид одного прогона.
 *
 * Собран из входных данных, а не из счётчика: одинаковый запрос обязан
 * давать одинаковый ответ. Иначе игрок, дважды посмотревший на один
 * и тот же предмет, увидит два разных числа и перестанет верить обоим.
 * Это же делает результат кэшируемым (GDD §6.4).
 */
function runSeed(playerId: string, zone: ZoneId, difficulty: Difficulty, index: number): string {
  return `${playerId}:${zone}:${difficulty}:${index}`;
}

export type PreviewInput = {
  readonly profile: PlayerProfile;
  readonly zone: ZoneId;
  readonly difficulty: Difficulty;
  readonly runs: number;
  /** Набор, ПО КОТОРОМУ считать. Гипотетический — тоже сюда. */
  readonly loadout: Loadout;
};

export type PreviewEstimate = {
  readonly winRate: number;
  readonly runs: number;
  readonly basis: 'sparring-dummy' | 'zone-enemy';
  readonly against?: readonly string[];
  readonly enemyLevel?: number;
};

export function estimateWinRate(input: PreviewInput): PreviewEstimate {
  const player = fighterFromLoadout(input.profile, input.loadout);
  const zone = zoneSpec(input.zone);

  /* Зоны нет — считаем по манекену и ГОВОРИМ об этом полем `basis`.
     Молча подставить манекен значило бы выдать оценку ни о чём
     за оценку по зоне. */
  if (zone === undefined) {
    const enemy = sparringDummy(input.profile.level, input.difficulty);
    return { ...duel(input, player, [enemy]), basis: 'sparring-dummy' };
  }

  const level = monsterLevel(input.profile.level, zone, input.difficulty);
  const enemies = zone.monsters.map((key) => monsterFighter(monsterSpec(key), level, zone.power));

  return {
    ...duel(input, player, enemies),
    basis: 'zone-enemy',
    against: zone.monsters,
    enemyLevel: level,
  };
}

/**
 * Доля побед против набора противников, поровну по каждому.
 *
 * Индекс прогона входит и в сид, и в выбор противника, поэтому при
 * одинаковом запросе раскладка воспроизводится побитово — включая то,
 * кому достался какой сид.
 */
function duel(
  input: PreviewInput,
  player: ReturnType<typeof fighterFromLoadout>,
  enemies: readonly ReturnType<typeof fighterFromLoadout>[],
): { winRate: number; runs: number } {
  let wins = 0;
  for (let i = 0; i < input.runs; i++) {
    const enemy = enemies[i % enemies.length];
    if (enemy === undefined) throw new Error('пустой набор противников для превью');

    const setup: BattleSetup = [player, enemy];
    const seed = runSeed(input.profile.id, input.zone, input.difficulty, i);
    const { outcome } = resolveBattle(setup, combatBalance, seed);
    // Ничья (упёрлись в лимит тиков) победой не считается.
    if (outcome.winner === 0) wins++;
  }

  return { winRate: wins / input.runs, runs: input.runs };
}
