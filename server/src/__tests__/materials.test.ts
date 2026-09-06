import { balance as balanceData } from '@extramundum/data';
import {
  dismantleYield,
  economyBalanceSchema,
  emberChanceFor,
  scrapTierFor,
  SCRAP_TIERS,
  seededRoll,
  type Difficulty,
} from '@extramundum/shared';
import { describe, expect, it } from 'vitest';

import { rollEmber } from '../runs/service.ts';

/**
 * Материалы: тир лома и высокий материал. GDD §6.3.
 *
 * Чистая часть — без базы: формулы живут в `shared`, бросок угля
 * детерминирован от сида забега. То, что происходит с ними в БД,
 * проверяет `items.test.ts` против настоящего Postgres.
 */

const economy = economyBalanceSchema.parse(balanceData.economy);

describe('тир лома', () => {
  it('ГРАНИЦЫ СОВПАДАЮТ С ДИАПАЗОНАМИ ЗОН, а не назначены отдельно', () => {
    /* Лом с зоны обязан чинить вещи той же зоны. Разойдись линейки,
       и «набил лома в Катакомбах» перестало бы значить «могу тронуть
       катакомбную вещь». Проверяются ОБЕ стороны каждой границы:
       проверка только внутри интервала прошла бы и при сдвинутой
       на единицу таблице. */
    const cases: readonly [number, string][] = [
      [1, 'T1'],
      [8, 'T1'],
      [9, 'T2'],
      [16, 'T2'],
      [17, 'T3'],
      [24, 'T3'],
      [25, 'T4'],
      [32, 'T4'],
      [33, 'T5'],
      [40, 'T5'],
    ];
    for (const [ilvl, tier] of cases) {
      expect(scrapTierFor(ilvl, economy), `ilvl ${ilvl}`).toBe(tier);
    }
  });

  it('выше последней границы тир не растёт дальше', () => {
    expect(scrapTierFor(400, economy)).toBe(SCRAP_TIERS[SCRAP_TIERS.length - 1]);
  });

  it('ДВЕ ОСИ: тир от уровня, количество от редкости', () => {
    /* Это и есть то, что закрывает дыру «набить сто эпиков на участке
       1-2»: количество там будет эпическое, а тир — первый, и тронуть
       им ничего выше восьмого уровня нельзя.

       Проверяется КРЕСТОМ: одна редкость на двух уровнях меняет только
       тир, один уровень на двух редкостях — только количество. Проверка
       по одной точке прошла бы и в том случае, если бы обе величины
       зависели от одного и того же. */
    const lowEpic = dismantleYield({ ilvl: 2, rarity: 'epic' }, economy);
    const highEpic = dismantleYield({ ilvl: 40, rarity: 'epic' }, economy);
    const lowCommon = dismantleYield({ ilvl: 2, rarity: 'common' }, economy);

    expect(lowEpic.tier).toBe('T1');
    expect(highEpic.tier).toBe('T5');
    expect(lowEpic.amount).toBe(highEpic.amount);

    expect(lowCommon.tier).toBe(lowEpic.tier);
    expect(lowCommon.amount).toBeLessThan(lowEpic.amount);
  });
});

describe('уголь горна', () => {
  const SEEDS = 4000;

  /** Сколько углей выпало бы за столько-то боёв на этой сложности. */
  const rate = (difficulty: Difficulty): number => {
    let hits = 0;
    for (let i = 0; i < SEEDS; i++) {
      hits += rollEmber({ seed: `ember-probe-${String(i)}`, difficulty, fightIndex: i % 5 });
    }
    return hits / SEEDS;
  };

  it('НА «НОРМАЛЬНО» НЕ ПАДАЕТ ВОВСЕ, а на кошмаре падает', () => {
    /* Пара обязательна: «не падает» проходит и тогда, когда бросок
       сломан и не срабатывает нигде. Второе число доказывает, что
       выборка живая, и доказывает это В ТОМ ЖЕ прогоне. */
    expect(rate('normal')).toBe(0);
    expect(rate('nightmare')).toBeGreaterThan(0.1);
  });

  it('частота совпадает с назначенной в данных', () => {
    for (const difficulty of ['dangerous', 'nightmare'] as const) {
      expect(rate(difficulty), difficulty).toBeCloseTo(emberChanceFor(difficulty, economy), 2);
    }
  });

  it('БРОСОК СВОЙ, а не тот же, что выбирает монстра', () => {
    /* Общий бросок связал бы «кто вышел» с «упал ли уголь», и две
       величины, которые игрок читает по отдельности, ходили бы парой.
       Пункт 5 аудита v1.0 в другом месте.

       Меряется КОРРЕЛЯЦИЯ двух потоков на одних и тех же сидах, а не
       наличие разных строк в коде: строки разойтись могут, а хеш всё
       равно дать близкие значения — ровно этим и болел рукописный
       FNV-1a до финального перемешивания.

       Пара к проверке: сначала поток сравнивается САМ С СОБОЙ, и там
       корреляция обязана быть единицей. Без этого «около нуля» прошло
       бы и на приборе, который всегда печатает ноль. */
    const ember = (i: number): number => seededRoll(`s${String(i)}:ember:0`);
    const enemy = (i: number): number => seededRoll(`s${String(i)}:enemy:0`);

    const corr = (a: (i: number) => number, b: (i: number) => number): number => {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let i = 0; i < SEEDS; i++) {
        const x = a(i);
        const y = b(i);
        sa += x;
        sb += y;
        saa += x * x;
        sbb += y * y;
        sab += x * y;
      }
      const n = SEEDS;
      const cov = sab / n - (sa / n) * (sb / n);
      const va = saa / n - (sa / n) ** 2;
      const vb = sbb / n - (sb / n) ** 2;
      return cov / Math.sqrt(va * vb);
    };

    expect(corr(ember, ember), 'прибор не воспроизводит известный ответ').toBeCloseTo(1, 6);
    expect(Math.abs(corr(ember, enemy)), 'потоки связаны').toBeLessThan(0.05);
  });
});
