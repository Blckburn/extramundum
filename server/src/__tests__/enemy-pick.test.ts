import { ZONES } from '@extramundum/data/zones';
import { describe, expect, it } from 'vitest';

import { enemyFor } from '../runs/service.ts';

/**
 * СОСТАВ КЛЮЧА, а не сам хеш: его независимость проверена
 * в `packages/shared/src/__tests__/rolls.test.ts`. Здесь проверяется,
 * что забег действительно встречает РАЗНЫХ противников — то есть что
 * в ключ входит номер боя и что он до броска доезжает.
 *
 * Это не дубль: хеш можно починить и всё равно подставить в него
 * одно и то же. Именно так и было — приём чинили в одном месте
 * из двух.
 */
const RUNS = 600;
const wastes = ZONES.find((z) => z.id === 'wastes');
if (wastes === undefined) throw new Error('нет зоны wastes');

describe('противники забега', () => {
  it('забег встречает РАЗНЫХ рядовых монстров, а не одного четырежды', () => {
    let allSame = 0;
    for (let r = 0; r < RUNS; r++) {
      const seed = `run-${r}-${(r * 7919).toString(36)}`;
      const keys = [0, 1, 2, 3].map((f) => enemyFor(wastes, f, seed).key);
      if (new Set(keys).size === 1) allSame++;
    }
    /* Сломанная версия давала 96.7%. При независимости и трёх монстрах
       ожидание 3 × (1/3)^4 = 3.7%. */
    expect(allSame / RUNS).toBeLessThan(0.1);
  });

  it('и при этом каждый монстр зоны действительно встречается', () => {
    /* Пара к проверке выше. Без неё «разных монстров много» прошло бы
       и на генераторе, который выдаёт двух из трёх, никогда не выдавая
       третьего, — то есть на ещё одной поломке того же рода. */
    const seen = new Set<string>();
    for (let r = 0; r < RUNS; r++) {
      const seed = `run-${r}-${(r * 7919).toString(36)}`;
      for (const f of [0, 1, 2, 3]) seen.add(enemyFor(wastes, f, seed).key);
    }
    expect([...seen].sort()).toEqual([...wastes.monsters].sort());
  });

  it('пятый бой — босс, и он не участвует в броске', () => {
    for (let r = 0; r < 50; r++) {
      expect(enemyFor(wastes, 4, `run-${r}`).key).toBe(wastes.boss);
    }
  });
});
