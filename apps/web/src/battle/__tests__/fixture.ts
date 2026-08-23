import { readFileSync } from 'node:fs';

import type { BattleLog, BattleOutcome } from '@extramundum/shared';

/**
 * Эталонный лог для тестов воспроизведения.
 *
 * Порождён движком (`node scripts/battle-fixture.mjs`) и закоммичен.
 * Вызывать движок отсюда нельзя: он не попадает в клиент (инвариант 3),
 * и клиентский тест, импортирующий `@extramundum/sim`, пробил бы два
 * рубежа из четырёх ради удобства.
 *
 * Что эталон не расходится с движком, проверяет `server/src/__tests__/
 * fixture.test.ts` — там движок доступен по праву.
 */
export const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/battle.json', import.meta.url), 'utf8'),
) as {
  readonly seed: string;
  readonly outcome: BattleOutcome;
  readonly log: BattleLog;
};

export const log: BattleLog = fixture.log;
