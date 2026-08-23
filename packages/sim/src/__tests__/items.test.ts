import { describe, expect, it } from 'vitest';

import { resolveAttack } from '../damage.js';
import { createFighterState, effectiveStats, mightMultiplier } from '../fighter.js';
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
    expect(balance.items.mightBudget).toBe(2);

    // Две одинаковых: 1.1 × 1.1.
    expect(mightMultiplier([0.1, 0.1], balance)).toBeCloseTo(1.21, 10);
    // Третья не добавляет НИЧЕГО.
    expect(mightMultiplier([0.1, 0.1, 0.1], balance)).toBeCloseTo(1.21, 10);
    expect(mightMultiplier([0.1, 0.1, 0.1, 0.1, 0.1], balance)).toBeCloseTo(1.21, 10);
  });

  it('берутся именно СИЛЬНЕЙШИЕ, а не первые попавшиеся', () => {
    const expected = 1.15 * 1.12;
    for (const order of [
      [0.15, 0.12, 0.02],
      [0.02, 0.15, 0.12],
      [0.12, 0.02, 0.15],
    ]) {
      expect(mightMultiplier(order, balance)).toBeCloseTo(expected, 10);
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
    mightMultiplier(affixes, balance);
    expect(affixes).toEqual(copy);
  });

  it('пустой список даёт единицу, а не ноль', () => {
    expect(mightMultiplier([], balance)).toBe(1);
    expect(effectiveStats(state(), state(), balance).mightMultiplier).toBe(1);
  });

  it('попадает в разбор броска ОТДЕЛЬНЫМ полем', () => {
    // Смешавшись с множителем ATK, «Мощь» заставила бы журнал врать
    // ровно там, ради чего он написан.
    const attacker = state({ atk: 20, accuracy: 1000, damageAffixes: [0.15, 0.12, 0.15] });
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
      const attacker = state({ atk: 18, accuracy: 1000, damageAffixes: [0.12, 0.09] });
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
        state({ atk: 20, accuracy: 1000, damageAffixes: [0.15, 0.15] }),
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
