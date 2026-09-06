import { balance as balanceData } from '@extramundum/data';
import { economyBalanceSchema, STATUS_IDS } from '@extramundum/shared';
import { describe, expect, it } from 'vitest';

import { sipOf } from '../items/flasks.ts';

/**
 * Бросок фляги. GDD §7.2.
 *
 * Чистая часть, без базы: сколько восстановит и какой стороной ляжет
 * побочный эффект. То, что с ними делает транзакция, проверяет
 * `runs.test.ts` против настоящего Postgres.
 */
const economy = economyBalanceSchema.parse(balanceData.economy);
const RUNS = 4000;

const tierWithSide = economy.flasks.tiers.find((tier) => tier.side !== null);
const plainTier = economy.flasks.tiers.find((tier) => tier.side === null);

describe('восстановление', () => {
  it('ЛОЖИТСЯ В ДИАПАЗОН И ЗАПОЛНЯЕТ ЕГО, а не жмётся к середине', () => {
    /* «Внутри диапазона» верно и для функции, которая всегда возвращает
       середину, — то есть для фиксированной доли под видом броска.
       Поэтому рядом проверяется, что оба конца достигаются. */
    if (plainTier === undefined) throw new Error('нет тира без побочных эффектов');
    const [lo, hi] = plainTier.restore;
    expect(lo, 'диапазон вырожден — «бросок» ничего не значит').toBeLessThan(hi);

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < RUNS; i++) {
      const { fraction } = sipOf(plainTier.id, `run-${String(i)}`, i % 3);
      expect(fraction).toBeGreaterThanOrEqual(lo);
      expect(fraction).toBeLessThanOrEqual(hi);
      min = Math.min(min, fraction);
      max = Math.max(max, fraction);
    }

    const span = hi - lo;
    expect(min, 'нижний конец диапазона не достигается').toBeLessThan(lo + span * 0.05);
    expect(max, 'верхний конец диапазона не достигается').toBeGreaterThan(hi - span * 0.05);
  });

  it('ОДИН СИД И ОДИН НОМЕР ГЛОТКА — ОДИН И ТОТ ЖЕ БРОСОК', () => {
    // Детерминизм и есть то, что не даёт переиграть неудачный глоток:
    // номер растёт вместе со списанием заряда.
    if (plainTier === undefined) throw new Error('нет тира без побочных эффектов');
    expect(sipOf(plainTier.id, 'seed', 0)).toEqual(sipOf(plainTier.id, 'seed', 0));
    expect(sipOf(plainTier.id, 'seed', 0).fraction).not.toBe(
      sipOf(plainTier.id, 'seed', 1).fraction,
    );
  });
});

describe('побочный эффект', () => {
  it('У НИЖНИХ ТИРОВ ЕГО НЕТ ВОВСЕ, а у верхнего есть', () => {
    /* Пара обязательна: «у дешёвой фляги побочных эффектов не бывает»
       проходит и на сломанном броске, который не срабатывает нигде. */
    if (plainTier === undefined || tierWithSide === undefined) {
      throw new Error('в балансе нет пары «с эффектом / без»');
    }

    let plain = 0;
    let fancy = 0;
    for (let i = 0; i < RUNS; i++) {
      if (sipOf(plainTier.id, `s${String(i)}`, 0).status !== null) plain += 1;
      if (sipOf(tierWithSide.id, `s${String(i)}`, 0).status !== null) fancy += 1;
    }

    expect(plain).toBe(0);
    expect(fancy, 'у верхнего тира эффект не выпал ни разу').toBeGreaterThan(0);
  });

  it('ОБЕ СТОРОНЫ РАВНОВЕРОЯТНЫ, и обе случаются', () => {
    /* «Побочный эффект в обе стороны» из §7.2 означает именно обе:
       выпадай только хорошая, верхний тир был бы просто лучшим,
       и выбор между тирами исчез бы. */
    if (tierWithSide === undefined || tierWithSide.side === null) {
      throw new Error('нет тира с побочным эффектом');
    }
    const side = tierWithSide.side;

    let good = 0;
    let bad = 0;
    for (let i = 0; i < RUNS; i++) {
      const status = sipOf(tierWithSide.id, `side-${String(i)}`, 0).status;
      if (status === null) continue;
      if (status.id === side.good) good += 1;
      else if (status.id === side.bad) bad += 1;
      else throw new Error(`фляга наложила посторонний статус «${status.id}»`);
    }

    expect(good / RUNS).toBeCloseTo(side.chance, 1);
    expect(bad / RUNS).toBeCloseTo(side.chance, 1);
  });

  it('ЭФФЕКТЫ — СУЩЕСТВУЮЩИЕ СТАТУСЫ РЕЕСТРА, а не свои', () => {
    /* Свой статус потребовал бы правки движка ради двух строк, а реестр
       десяти эффектов на то и сделан, чтобы механика собиралась из него.
       Схема баланса требует именно `statusIdSchema` — здесь проверяется,
       что данные ей удовлетворяют, то есть что тест не пуст. */
    for (const tier of economy.flasks.tiers) {
      if (tier.side === null) continue;
      expect(STATUS_IDS).toContain(tier.side.good);
      expect(STATUS_IDS).toContain(tier.side.bad);
    }
    expect(economy.flasks.tiers.some((tier) => tier.side !== null)).toBe(true);
  });

  it('БРОСОК ЭФФЕКТА — СВОЙ, а не тот же, что у восстановления', () => {
    /* Общий бросок связал бы «сколько вылечило» с «какой стороной легло»,
       и две величины, которые игрок читает по отдельности, ходили бы
       парой. Тот же пункт 5 аудита v1.0.

       Пара к проверке: поток сравнивается сам с собой, и там корреляция
       обязана быть единицей — иначе «около нуля» прошло бы и на приборе,
       который всегда печатает ноль. */
    if (tierWithSide === undefined) throw new Error('нет тира с побочным эффектом');

    const restore = (i: number): number => sipOf(tierWithSide.id, `c${String(i)}`, 0).fraction;
    const sideHit = (i: number): number =>
      sipOf(tierWithSide.id, `c${String(i)}`, 0).status === null ? 0 : 1;

    expect(corr(restore, restore, RUNS), 'прибор не воспроизводит известный ответ').toBeCloseTo(
      1,
      6,
    );
    expect(Math.abs(corr(restore, sideHit, RUNS)), 'броски связаны').toBeLessThan(0.05);
  });
});

/** Корреляция двух потоков на одних и тех же входах. */
function corr(a: (i: number) => number, b: (i: number) => number, n: number): number {
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let i = 0; i < n; i++) {
    const x = a(i);
    const y = b(i);
    sa += x;
    sb += y;
    saa += x * x;
    sbb += y * y;
    sab += x * y;
  }
  const cov = sab / n - (sa / n) * (sb / n);
  const va = saa / n - (sa / n) ** 2;
  const vb = sbb / n - (sb / n) ** 2;
  return cov / Math.sqrt(va * vb);
}
