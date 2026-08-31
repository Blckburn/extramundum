import { describe, expect, it } from 'vitest';

import { seededRoll } from '../rolls.js';

/**
 * НЕЗАВИСИМОСТЬ СОСЕДНИХ БРОСКОВ, а не их частота.
 *
 * Частота была безупречна и в сломанной версии: каждый из трёх монстров
 * выпадал ровно в 33.3% боёв, дробный остаток срабатывал в 24.7%
 * при ожидании 25%. Сломана была связь между ключами, различающимися
 * ПОСЛЕДНИМ символом, — а таковы все наши ключи: номер боя 0..3, шаг
 * оффера 0..2.
 *
 * Замерено на сломанной версии, для сравнения с проверками ниже:
 *
 *   все четыре боя против одного монстра   96.7%   (должно быть 3.7%)
 *   остаток лута сработал во всех пяти     22.7%   (должно быть 0.1%)
 *   остаток лута не сработал ни разу       73.3%   (должно быть 23.7%)
 *
 * Поэтому здесь НЕТ теста «доли равномерны»: он проходил всегда
 * и ровно поэтому ничего не стоил.
 */
const seeds = Array.from({ length: 4000 }, (_, i) => `run-${i}-${(i * 7919).toString(36)}`);

describe('бросок из строки', () => {
  it('соседние индексы дают РАЗНЫЕ корзины, а не одну на весь забег', () => {
    const POOL = 3;
    const FIGHTS = 4;
    const bucket = (r: number) => Math.min(POOL - 1, Math.floor(r * POOL));

    let allSame = 0;
    for (const seed of seeds) {
      const picks = Array.from({ length: FIGHTS }, (_, f) =>
        bucket(seededRoll(`${seed}:enemy:${f}`)),
      );
      if (new Set(picks).size === 1) allSame++;
    }

    /* Ожидание при независимости: POOL × (1/POOL)^FIGHTS = 3.7%.
       Сломанная версия давала 96.7%. Порог посередине не годится —
       он прошёл бы и на заметно скоррелированном броске. */
    const share = allSame / seeds.length;
    expect(share).toBeGreaterThan(0.01);
    expect(share).toBeLessThan(0.08);
  });

  it('соседние индексы дают разные ЗНАЧЕНИЯ, и разброс велик', () => {
    /* Прямая проверка того же свойства без корзин: у сломанной версии
       соседние броски различались на 0.4% диапазона. Проверяется
       МЕДИАНА разницы — среднее утащил бы редкий выброс. */
    const diffs = seeds
      .map((seed) => Math.abs(seededRoll(`${seed}:enemy:0`) - seededRoll(`${seed}:enemy:1`)))
      .sort((a, b) => a - b);
    const median = diffs[Math.floor(diffs.length / 2)] ?? 0;

    // У независимых равномерных величин медиана |a−b| около 0.29.
    expect(median).toBeGreaterThan(0.2);
  });

  it('бросок детерминирован: та же строка — то же число', () => {
    /* Иначе всё остальное бессмысленно: оффер, которого не найти
       при применении, и монстр, не совпавший с превью. */
    for (const seed of seeds.slice(0, 50)) {
      expect(seededRoll(`${seed}:enemy:2`)).toBe(seededRoll(`${seed}:enemy:2`));
    }
  });

  it('значения лежат в [0, 1)', () => {
    for (const seed of seeds.slice(0, 500)) {
      const r = seededRoll(`${seed}:draft:7:1`);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
  });

  it('дробный остаток срабатывает НЕЗАВИСИМО в каждом бою', () => {
    /* То же свойство на втором применении броска — округлении числа
       предметов. Сломанная версия делала забег «везучим целиком»
       или «невезучим целиком»: 22.7% против 73.3%. */
    const FRACTION = 0.25;
    let allHit = 0;
    let noneHit = 0;
    for (const seed of seeds) {
      const hits = [0, 1, 2, 3, 4].filter(
        (f) => seededRoll(`${seed}:enemy:${1000 + f}`) < FRACTION,
      ).length;
      if (hits === 5) allHit++;
      if (hits === 0) noneHit++;
    }
    // Ожидание: 0.25^5 = 0.1% и 0.75^5 = 23.7%.
    expect(allHit / seeds.length).toBeLessThan(0.01);
    expect(noneHit / seeds.length).toBeGreaterThan(0.15);
    expect(noneHit / seeds.length).toBeLessThan(0.32);
  });
});
