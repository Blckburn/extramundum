import { monsterSpec, zoneSpec } from '@extramundum/data/zones';
import {
  segmentBounds,
  type BattleSetup,
  type Difficulty,
  type PlayerProfile,
  type ZoneId,
} from '@extramundum/shared';
import { resolveBattle } from '@extramundum/sim';

import { fighterFromLoadout, type Loadout, type ProgressionBonuses } from '../items/loadout.ts';

import { monsterFighter, monsterPower } from './monsters.ts';
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
function runSeed(
  playerId: string,
  zone: ZoneId,
  segment: number,
  difficulty: Difficulty,
  index: number,
): string {
  return `${playerId}:${zone}:${segment}:${difficulty}:${index}`;
}

export type PreviewInput = {
  readonly profile: PlayerProfile;
  readonly zone: ZoneId;
  /** Участок зоны: он и задаёт уровень противников. */
  readonly segment: number;
  readonly difficulty: Difficulty;
  readonly runs: number;
  /** Набор, ПО КОТОРОМУ считать. Гипотетический — тоже сюда. */
  readonly loadout: Loadout;
  /* Карты и трейты прогрессии. ПОЛЕ ОБЯЗАТЕЛЬНОЕ: превью, считающее
     бойца без его карт, отвечает не на тот вопрос, который задал
     игрок, — и врёт тем убедительнее, чем дальше игрок прошёл. */
  readonly progression: ProgressionBonuses;
};

export type PreviewEstimate = {
  readonly winRate: number;
  readonly runs: number;
  readonly basis: 'sparring-dummy' | 'zone-enemy';
  readonly against?: readonly string[];
  /**
   * Границы уровней участка, а не одно число.
   *
   * Внутри участка уровень разыгрывается броском, поэтому одно число
   * описывало бы половину боёв неверно. Прогоны раскладываются
   * по ВСЕМ парам «монстр × уровень» — по той же причине, по которой
   * они раскладываются по монстрам: место — это набор случаев,
   * и оценка обязана учитывать их все.
   */
  readonly enemyLevels?: readonly [number, number];
  /**
   * Насколько тир сложности усиливает врага. GDD §7.3.
   *
   * Отдаётся наружу по той же причине, что уровень и матчап: «ничего
   * не спрятано» (§4.3). После правки §7.3 тир не двигает уровень —
   * без этого числа игрок не увидел бы разницы между тирами вовсе,
   * а превью не смогло бы её показать.
   */
  readonly enemyPower?: number;
};

export function estimateWinRate(input: PreviewInput): PreviewEstimate {
  const player = fighterFromLoadout(input.profile, input.loadout, input.progression);
  const zone = zoneSpec(input.zone);

  /* Зоны нет — считаем по манекену и ГОВОРИМ об этом полем `basis`.
     Молча подставить манекен значило бы выдать оценку ни о чём
     за оценку по зоне. */
  if (zone === undefined) {
    const enemy = sparringDummy(input.profile.level, input.difficulty);
    return { ...duel(input, player, [enemy]), basis: 'sparring-dummy' };
  }

  const [lo, hi] = segmentBounds(zone, input.segment);
  const power = monsterPower(zone, input.segment, input.difficulty);
  const enemies = zone.monsters.flatMap((key) => {
    const spec = monsterSpec(key);
    const out = [];
    for (let level = lo; level <= hi; level++) out.push(monsterFighter(spec, level, power));
    return out;
  });

  return {
    ...duel(input, player, enemies),
    basis: 'zone-enemy',
    against: zone.monsters,
    enemyLevels: [lo, hi],
    enemyPower: power,
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
    const seed = runSeed(input.profile.id, input.zone, input.segment, input.difficulty, i);
    const { outcome } = resolveBattle(setup, combatBalance, seed);
    // Ничья (упёрлись в лимит тиков) победой не считается.
    if (outcome.winner === 0) wins++;
  }

  return { winRate: wins / input.runs, runs: input.runs };
}
