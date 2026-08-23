import type { BattleSetup, Difficulty, PlayerProfile, ZoneId } from '@extramundum/shared';
import { resolveBattle } from '@extramundum/sim';

import { combatBalance, fighterFromProfile, sparringDummy } from './setup.ts';

/**
 * Оценка шанса победы. GDD §6.4.
 *
 * «В автобаттлере игрок не может сыграть лучше, поэтому вопрос
 * "стало ли лучше?" должен получать честный численный ответ.»
 *
 * Метод — Монте-Карло: N боёв на разных сидах, доля побед. Состояние
 * не меняется, награды не выдаются, в БД ничего не пишется.
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
};

export function estimateWinRate(input: PreviewInput): { winRate: number; runs: number } {
  const player = fighterFromProfile(input.profile);
  const enemy = sparringDummy(input.profile.level, input.difficulty);
  const setup: BattleSetup = [player, enemy];

  let wins = 0;
  for (let i = 0; i < input.runs; i++) {
    const seed = runSeed(input.profile.id, input.zone, input.difficulty, i);
    const { outcome } = resolveBattle(setup, combatBalance, seed);
    // Ничья (упёрлись в лимит тиков) победой не считается.
    if (outcome.winner === 0) wins++;
  }

  return { winRate: wins / input.runs, runs: input.runs };
}
