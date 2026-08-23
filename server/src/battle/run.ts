import type { BattleSetup, Difficulty, PlayerProfile, ZoneId } from '@extramundum/shared';
import { maxHp as maxHpOf, resolveBattle } from '@extramundum/sim';
import { randomUUID } from 'node:crypto';

import { battles } from '../db/schema/runs.ts';
import type { Database } from '../db/client.ts';

import { combatBalance, fighterFromProfile, sparringDummy } from './setup.ts';

/**
 * Проведение боя. GDD §3.2.
 *
 * Порядок шагов документа соблюдён и важен:
 *   1. состояние игрока читается ИЗ БД, а не из тела запроса;
 *   2. сид генерируется НА СЕРВЕРЕ;
 *   3. движок разрешает бой;
 *   4. лог пишется в базу вместе с сидом — по ним бой перепроверяем;
 *   5. клиент получает готовый результат.
 *
 * Клиенту нечем повлиять на исход: он не сообщает ни одного числа
 * о бойце и узнаёт результат уже записанным. Максимум, что он может, —
 * не смотреть анимацию.
 *
 * **Награды НЕ применяются, и это записано в базе.** Шаг 5 документа
 * требует применить HP, XP, золото и лут в одной транзакции, но
 * прогрессия — это M3. Строка помечается `provisional`, чтобы потом
 * не выяснять, почему часть боёв без наград.
 */

/**
 * Сид боя.
 *
 * Случайный, а не выведенный из состояния: два подряд идущих боя одним
 * и тем же составом обязаны отличаться, иначе рейд превращается
 * в повторение одного результата. Сид сохраняется рядом с логом,
 * поэтому воспроизводимость от этого не страдает.
 */
function battleSeed(): string {
  return randomUUID();
}

export type RunBattleInput = {
  readonly profile: PlayerProfile;
  readonly zone: ZoneId;
  readonly difficulty: Difficulty;
};

export async function runBattle(db: Database, input: RunBattleInput) {
  const player = fighterFromProfile(input.profile);
  const enemy = sparringDummy(input.profile.level, input.difficulty);
  const setup: BattleSetup = [player, enemy];

  const seed = battleSeed();
  const { log, outcome } = resolveBattle(setup, combatBalance, seed);

  /**
   * Ничья считается НЕ ПОБЕДОЙ, а не отдельным исходом.
   *
   * Перечисление `battle_result` в схеме (GDD §3.3) знает только `win`
   * и `loss`; заводить третье значение самовольно — это правка схемы БД
   * и документа. А главное, так уже считает превью шанса победы
   * (`estimateWinRate`): разойдись они, игрок увидел бы обещание
   * «65% побед» и результат по другому определению победы.
   *
   * Ничья возможна только при упоре в лимит тиков — на выверенных
   * числах §4.6 она не встречается ни разу на 10 000 боёв.
   */
  const result = outcome.winner === 0 ? 'win' : 'loss';

  const [row] = await db
    .insert(battles)
    .values({
      playerId: input.profile.id,
      opponentRef: `sparring:${input.difficulty}`,
      seed,
      log,
      result,
      rewards: {},
      provisional: true,
    })
    .returning({ id: battles.id });

  if (row === undefined) throw new Error('бой не записан в базу');

  // Максимум HP считает движок и присылает клиенту: вывести его из лога
  // нельзя, а формула в браузер не попадает (инвариант 3).
  const maxHp: [number, number] = [maxHpOf(player, combatBalance), maxHpOf(enemy, combatBalance)];

  return { battleId: row.id, log, outcome, maxHp, provisional: true as const };
}
