import { describe, expect, it } from 'vitest';

import { resolveAttack } from '../damage.js';
import {
  createFighterState,
  effectiveStats,
  familyMultiplier,
  familySum,
  maxHp,
} from '../fighter.js';
import { rngFromSeed } from '../rng.js';

import { balance, fighter } from './helpers.js';

/**
 * Снаряжение в бою. GDD §5.3 (оффхенд), §6.1 («Мощь»).
 *
 * Число бросков за удар здесь не проверяется — это independence.test.ts,
 * там же и диверсии на него. Здесь проверяется, что снаряжение вообще
 * что-то ДЕЛАЕТ и делает ровно обещанное.
 */

const state = (overrides: Parameters<typeof fighter>[0] = {}) =>
  createFighterState(fighter(overrides), balance);

describe('бюджет семейства «Мощь»', () => {
  it('учитываются ДВЕ сильнейшие, остальные не считаются', () => {
    expect(balance.items.familyBudget.might).toBe(2);

    // Две одинаковых: 1.1 × 1.1.
    expect(familyMultiplier([0.1, 0.1], balance, 'might')).toBeCloseTo(1.21, 10);
    // Третья не добавляет НИЧЕГО.
    expect(familyMultiplier([0.1, 0.1, 0.1], balance, 'might')).toBeCloseTo(1.21, 10);
    expect(familyMultiplier([0.1, 0.1, 0.1, 0.1, 0.1], balance, 'might')).toBeCloseTo(1.21, 10);
  });

  it('берутся именно СИЛЬНЕЙШИЕ, а не первые попавшиеся', () => {
    const expected = 1.15 * 1.12;
    for (const order of [
      [0.15, 0.12, 0.02],
      [0.02, 0.15, 0.12],
      [0.12, 0.02, 0.15],
    ]) {
      expect(familyMultiplier(order, balance, 'might')).toBeCloseTo(expected, 10);
    }
  });

  it('третий аффикс БЫЛ БЫ значим, если бы считался', () => {
    // Иначе «третий не добавляет ничего» проходило бы и на наборе,
    // где третий равен нулю: проверялось бы отсутствие того, чего нет.
    const all = 1.1 * 1.1 * 1.1;
    expect(all).toBeGreaterThan(1.21 + 0.05);
  });

  it('не мутирует переданный список', () => {
    // Конфигурация бойца общая на весь прогон матрицы: сортировка
    // на месте меняла бы входные данные из функции, обязанной быть чистой.
    const affixes = [0.02, 0.15, 0.12];
    const copy = [...affixes];
    familyMultiplier(affixes, balance, 'might');
    expect(affixes).toEqual(copy);
  });

  it('пустой список даёт единицу, а не ноль', () => {
    expect(familyMultiplier([], balance, 'might')).toBe(1);
    expect(effectiveStats(state(), state(), balance).mightMultiplier).toBe(1);
  });

  it('попадает в разбор броска ОТДЕЛЬНЫМ полем', () => {
    // Смешавшись с множителем ATK, «Мощь» заставила бы журнал врать
    // ровно там, ради чего он написан.
    const attacker = state({
      atk: 20,
      accuracy: 1000,
      percentAffixes: { might: [0.15, 0.12, 0.15], bastion: [], swiftness: [] },
    });
    const outcome = resolveAttack(attacker, state(), balance, rngFromSeed('might'), 0, 1);

    expect(outcome.kind).toBe('hit');
    if (outcome.kind !== 'hit') return;

    expect(outcome.roll.mightMultiplier).toBeCloseTo(1.15 * 1.15, 10);
    // И это НЕ то же самое, что множитель ATK: поля разные.
    expect(outcome.roll.atkMultiplier).not.toBeCloseTo(outcome.roll.mightMultiplier, 3);
  });

  it('произведение шагов по-прежнему даёт итог', () => {
    // Свойство разбора из M1a: поле, добавленное в него, обязано
    // участвовать в произведении, а не лежать рядом для красоты.
    for (let i = 0; i < 60; i++) {
      const attacker = state({
        atk: 18,
        accuracy: 1000,
        percentAffixes: { might: [0.12, 0.09], bastion: [], swiftness: [] },
      });
      const outcome = resolveAttack(
        attacker,
        state({ armor: 8 }),
        balance,
        rngFromSeed(`p-${i}`),
        0,
        1,
      );
      if (outcome.kind !== 'hit') continue;

      const r = outcome.roll;
      const product =
        r.weaponRoll *
        r.ilvlScale *
        r.atkMultiplier *
        r.mightMultiplier *
        r.matchupMultiplier *
        (1 - r.mitigation) *
        r.critMultiplier *
        (1 - r.blockReduction);
      expect(Math.max(0, Math.round(product))).toBe(r.final);
    }
  });

  it('«Мощь» действительно поднимает урон', () => {
    // Множитель, который ни на что не влияет, — это пункт 4 аудита v1.0.
    let withAffix = 0;
    let without = 0;

    for (let i = 0; i < 200; i++) {
      const seed = `dmg-${i}`;
      const a = resolveAttack(
        state({
          atk: 20,
          accuracy: 1000,
          percentAffixes: { might: [0.15, 0.15], bastion: [], swiftness: [] },
        }),
        state(),
        balance,
        rngFromSeed(seed),
        0,
        1,
      );
      const b = resolveAttack(
        state({ atk: 20, accuracy: 1000 }),
        state(),
        balance,
        rngFromSeed(seed),
        0,
        1,
      );
      if (a.kind === 'hit') withAffix += a.damage;
      if (b.kind === 'hit') without += b.damage;
    }

    expect(without).toBeGreaterThan(0);
    // 1.15 × 1.15 = 1.3225; округление до целого даёт разброс, поэтому
    // сравнивается сумма по выборке, а не отдельный удар.
    expect(withAffix / without).toBeCloseTo(1.3225, 1);
  });
});

describe('три вида оффхенда', () => {
  it('щит гасит удар, второе оружие и фокус — нет', () => {
    const shieldBlocks = (offhand: Parameters<typeof fighter>[0]['offhand']) => {
      let blocked = 0;
      for (let i = 0; i < 400; i++) {
        const outcome = resolveAttack(
          state({ atk: 20, accuracy: 1000 }),
          state({ offhand: offhand ?? null }),
          balance,
          rngFromSeed(`blk-${i}`),
          0,
          1,
        );
        if (outcome.kind === 'hit' && outcome.roll.blockReduction > 0) blocked++;
      }
      return blocked;
    };

    expect(shieldBlocks({ kind: 'shield', blockChance: 0.5, blockReduction: 0.7 })).toBeGreaterThan(
      100,
    );
    expect(shieldBlocks({ kind: 'weapon', dmgMin: 3, dmgMax: 6 })).toBe(0);
    expect(shieldBlocks({ kind: 'focus', statusPower: 1.4 })).toBe(0);
    expect(shieldBlocks(null)).toBe(0);
  });

  it('второе оружие прибавляет урон, не тратя лишнего броска', () => {
    let armed = 0;
    let bare = 0;

    for (let i = 0; i < 200; i++) {
      const seed = `oh-${i}`;
      const a = resolveAttack(
        state({ atk: 10, accuracy: 1000, offhand: { kind: 'weapon', dmgMin: 5, dmgMax: 5 } }),
        state(),
        balance,
        rngFromSeed(seed),
        0,
        1,
      );
      const b = resolveAttack(
        state({ atk: 10, accuracy: 1000 }),
        state(),
        balance,
        rngFromSeed(seed),
        0,
        1,
      );
      if (a.kind === 'hit') armed += a.roll.weaponRoll;
      if (b.kind === 'hit') bare += b.roll.weaponRoll;
    }

    // Основное оружие в обвязке — ровно 10, второе — ровно 5.
    expect(bare / 200).toBeCloseTo(10, 6);
    expect(armed / 200).toBeCloseTo(15, 6);
  });

  it('фокус усиливает СВОИ статусы тем же механизмом, что amplifier', () => {
    const plain = effectiveStats(state(), state(), balance);
    const withFocus = effectiveStats(
      state({ offhand: { kind: 'focus', statusPower: 1.4 } }),
      state(),
      balance,
    );

    expect(plain.dotDamageBonus).toBe(0);
    expect(withFocus.dotDamageBonus).toBeCloseTo(0.4, 10);
  });

  it('фокус не даёт ни блока, ни урона', () => {
    const focus = state({ offhand: { kind: 'focus', statusPower: 1.4 } });
    const outcome = resolveAttack(focus, state(), balance, rngFromSeed('f'), 0, 1);
    if (outcome.kind !== 'hit') throw new Error('удар не дошёл, сравнивать нечего');

    const bare = resolveAttack(state(), state(), balance, rngFromSeed('f'), 0, 1);
    if (bare.kind !== 'hit') throw new Error('удар не дошёл, сравнивать нечего');

    expect(outcome.roll.weaponRoll).toBeCloseTo(bare.roll.weaponRoll, 10);
    expect(outcome.roll.blockReduction).toBe(0);
  });
});

describe('защитные семейства аффиксов (M3b)', () => {
  /**
   * Пять семейств из §5.3, добавленных решением человека. Здесь
   * проверяется, что каждое ДЕЛАЕТ ровно обещанное и что бюджет
   * процентных держит движок, а не сервер.
   */

  it('«Оплот» умножает броню, а не прибавляет к ней', () => {
    const plain = state({ armor: 100 });
    const bastion = state({
      armor: 100,
      percentAffixes: { might: [], bastion: [0.2], swiftness: [] },
    });

    expect(effectiveStats(plain, plain, balance).armor).toBeCloseTo(100, 10);
    expect(effectiveStats(bastion, plain, balance).armor).toBeCloseTo(120, 10);
  });

  it('«Оплот» ограничен бюджетом — и третий БЫЛ БЫ значим', () => {
    const budget = balance.items.familyBudget.bastion;
    const values = Array.from({ length: budget + 1 }, () => 0.2);

    const counted = familyMultiplier(values, balance, 'bastion');
    const all = 1.2 ** values.length;

    expect(counted).toBeCloseTo(1.2 ** budget, 10);
    // Иначе проверка прошла бы и на бюджете, равном длине списка:
    // отсутствие эффекта неотличимо от отсутствия лишнего аффикса.
    expect(all).toBeGreaterThan(counted + 0.05);
  });

  it('«Проворство» умножает SPD и тоже ограничено бюджетом', () => {
    const plain = state({ spd: 10 });
    const swift = state({
      spd: 10,
      percentAffixes: { might: [], bastion: [], swiftness: [0.12] },
    });

    expect(effectiveStats(plain, plain, balance).spd).toBeCloseTo(10, 10);
    expect(effectiveStats(swift, plain, balance).spd).toBeCloseTo(11.2, 10);

    const budget = balance.items.familyBudget.swiftness;
    const over = Array.from({ length: budget + 1 }, () => 0.12);
    expect(familyMultiplier(over, balance, 'swiftness')).toBeCloseTo(1.12 ** budget, 10);
    expect(1.12 ** over.length).toBeGreaterThan(1.12 ** budget + 0.01);
  });

  it('«Проворство» не может увести SPD ниже пола', () => {
    // Пол по SPD — жёсткое правило (§4.4): замедленный обязан ходить.
    // Множитель семейства обязан ему подчиняться, как и chill.
    const slow = state({ spd: 1, percentAffixes: { might: [], bastion: [], swiftness: [] } });
    expect(effectiveStats(slow, slow, balance).spd).toBe(balance.tick.minSpd);
  });

  it('«Жила» поднимает максимум HP ОТДЕЛЬНО от бонусов путей', () => {
    /* Два источника HP хранятся раздельно — это прямая профилактика бага
       v1.0 (§13, пункт 2), где пересчёт максимума молча стирал бонусы
       путей. Проверяем, что каждый слагается сам по себе и что их сумма
       не теряется. */
    const bare = maxHp(fighter({}), balance);
    const path = maxHp(fighter({ pathBonusHp: 30 }), balance);
    const gear = maxHp(fighter({ gearBonusHp: 40 }), balance);
    const both = maxHp(fighter({ pathBonusHp: 30, gearBonusHp: 40 }), balance);

    expect(path).toBe(bare + 30);
    expect(gear).toBe(bare + 40);
    expect(both).toBe(bare + 70);
  });

  it('«Верность руки» — это точность, и она СНИЖАЕТ уклонение цели', () => {
    /* Точность приходит только из аффиксов (§4.2), поэтому её эффект
       обязан быть виден в бою, а не только в тултипе: ровно этим
       отличается механика от числа в описании (§13, пункт 4). */
    const nimble = { agi: 25 } as const;

    let missesBlind = 0;
    let missesSharp = 0;
    for (let i = 0; i < 400; i++) {
      const blind = resolveAttack(
        state({ accuracy: 0 }),
        state(nimble),
        balance,
        rngFromSeed(`acc-${i}`),
        0,
        1,
      );
      const sharp = resolveAttack(
        state({ accuracy: 20 }),
        state(nimble),
        balance,
        rngFromSeed(`acc-${i}`),
        0,
        1,
      );
      if (blind.kind === 'dodged') missesBlind++;
      if (sharp.kind === 'dodged') missesSharp++;
    }

    // Уклонение обязано быть ЖИВЫМ в обеих выборках, иначе «точность
    // снижает промахи» проходило бы и при нуле промахов у обоих.
    expect(missesBlind).toBeGreaterThan(40);
    expect(missesSharp).toBeGreaterThan(0);
    expect(missesSharp).toBeLessThan(missesBlind);
  });
});

/**
 * Бюджет «Верности руки» — ПЛОСКОГО семейства. GDD §6.1, §4.2.
 *
 * Бюджет считался свойством формы: «процентные перемножаются, значит
 * их надо ограничивать». Замер показал, что он свойство НАСЫЩЕНИЯ:
 * у шанса уклонения есть потолок, и точность сверх него не даёт
 * ничего — третий аффикс T1 добавляет 0.6 п.п., четвёртый ноль.
 * Без бюджета они пропадали бы молча.
 */
describe('бюджет «Верности руки»', () => {
  it('складываются ДВЕ сильнейшие, остальные не считаются', () => {
    expect(balance.items.familyBudget.truehand).toBe(2);

    expect(familySum([10, 10], balance, 'truehand')).toBe(20);
    // Третья и четвёртая не добавляют НИЧЕГО.
    expect(familySum([10, 10, 10], balance, 'truehand')).toBe(20);
    expect(familySum([10, 10, 10, 10], balance, 'truehand')).toBe(20);
  });

  it('третий аффикс БЫЛ БЫ значим, если бы считался', () => {
    // Иначе «третий не добавляет ничего» проходило бы и на наборе,
    // где третьего попросту нет: проверять надо, что он был отброшен,
    // а не что его не было.
    const two = familySum([10, 10], balance, 'truehand');
    const three = [10, 10, 10].reduce((a, b) => a + b, 0);
    expect(three).toBeGreaterThan(two);
  });

  it('берутся именно СИЛЬНЕЙШИЕ, а не первые попавшиеся', () => {
    for (const order of [
      [3, 12, 7, 15],
      [15, 12, 7, 3],
      [7, 15, 3, 12],
    ]) {
      expect(familySum(order, balance, 'truehand')).toBe(27);
    }
  });

  it('складывается СУММА, а не произведение', () => {
    // Разница видна только на числах, где сумма и произведение
    // расходятся: на [1, 1] обе дали бы 2 и 1 соответственно,
    // но на [3, 4] сумма 7, а произведение 12.
    expect(familySum([3, 4], balance, 'truehand')).toBe(7);
  });

  it('не мутирует переданный список', () => {
    const affixes = [3, 12, 7];
    const copy = [...affixes];
    familySum(affixes, balance, 'truehand');
    expect(affixes).toEqual(copy);
  });

  it('пустой список даёт ноль, а не единицу', () => {
    // У множителя нейтральный элемент — единица, у суммы ноль.
    // Перепутать их значит выдать всем бойцам единицу точности.
    expect(familySum([], balance, 'truehand')).toBe(0);
  });

  it('бюджет доходит до БОЙЦА, а не остаётся в функции', () => {
    const budgeted = createFighterState(
      fighter({ accuracy: 0, accuracyAffixes: [10, 10, 10, 10] }),
      balance,
    );
    const two = createFighterState(fighter({ accuracy: 0, accuracyAffixes: [10, 10] }), balance);
    const bare = createFighterState(fighter({ accuracy: 0, accuracyAffixes: [] }), balance);

    const acc = (state: typeof bare) => effectiveStats(state, bare, balance).accuracy;

    // Четыре аффикса дают ровно столько же, сколько два.
    expect(acc(budgeted)).toBe(acc(two));
    // И это НЕ ноль: иначе равенство выполнялось бы и на движке,
    // который точность из снаряжения не читает вовсе.
    expect(acc(two)).toBeGreaterThan(acc(bare));
    expect(acc(two)).toBe(20);
  });
});
