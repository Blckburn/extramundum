import { readFileSync } from 'node:fs';

import { balance } from '@extramundum/data';
import { battleSetupSchema, combatBalanceSchema } from '@extramundum/shared';
import { resolveBattle } from '@extramundum/sim';
import { describe, expect, it } from 'vitest';

/**
 * Эталонный лог для тестов воспроизведения (M2b) сверяется с движком.
 *
 * Проигрыватель живёт в `apps/web`, куда движок не попадает (инвариант 3,
 * четыре рубежа). Поэтому его тесты работают против ЗАПИСАННОГО лога,
 * а не вызывают движок. Записанный лог рано или поздно расходится
 * с движком — этот тест и есть то место, где расхождение становится
 * красной сборкой, а не сюрпризом у игрока.
 *
 * Тест живёт здесь, а не в клиенте, потому что здесь движок доступен
 * по праву: сервер его и запускает.
 */

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../apps/web/src/battle/__tests__/fixtures/battle.json', import.meta.url),
    'utf8',
  ),
) as {
  seed: string;
  setup: unknown;
  outcome: unknown;
  log: { events: readonly { t: string }[] };
};

/** Все типы событий формата. Лог обязан содержать каждый. */
const EVENT_KINDS = [
  'turn_start',
  'attack',
  'dodge',
  'block',
  'damage',
  'status_apply',
  'status_tick',
  'status_expire',
  'trait_fire',
  'death',
] as const;

describe('эталонный боевой лог', () => {
  it('воспроизводится движком из записанных сида и состава', () => {
    const setup = battleSetupSchema.parse(fixture.setup);
    const result = resolveBattle(setup, combatBalanceSchema.parse(balance), fixture.seed);

    // Целиком, а не по числу событий: разошедшийся урон в одном ударе —
    // это тоже расхождение, и клиентские тесты о нём не узнают.
    expect(result.log).toEqual(fixture.log);
    expect(result.outcome).toEqual(fixture.outcome);
  });

  it('содержит КАЖДЫЙ тип события формата', () => {
    // Без этой проверки тесты проигрывателя вида «ни одно событие
    // не роняет показ» проходили бы на логе из одних ударов, то есть
    // не доказывали бы ничего. Тип, которого нет в выборке, — это
    // тип, который никто не проверял.
    const kinds = new Set(fixture.log.events.map((event) => event.t));
    for (const kind of EVENT_KINDS) {
      expect([...kinds], `в эталоне нет события «${kind}»`).toContain(kind);
    }
  });

  it('содержит урон ПО АТАКУЮЩЕМУ — иначе отражение никто не проверял', () => {
    // `thorns` бьёт в обратную сторону, и журнал обязан показывать это
    // отдельной строкой. Проверка «строка отражения не появляется
    // на обычном ударе» без этого прошла бы на логе, где отражения
    // не случалось ни разу.
    const events = fixture.log.events as readonly { t: string; actor?: number; target?: number }[];
    let reflected = 0;

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event === undefined || event.t !== 'damage') continue;
      for (let j = i - 1; j >= 0; j--) {
        const prior = events[j];
        if (prior === undefined) continue;
        if (prior.t !== 'turn_start' && prior.t !== 'attack') continue;
        if (prior.actor === event.target) reflected++;
        break;
      }
    }

    expect(reflected).toBeGreaterThan(0);
  });
});
