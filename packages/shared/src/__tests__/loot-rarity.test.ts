import { describe, expect, it } from 'vitest';

import { RARITIES, type Rarity } from '../items.js';
import { rarityWeightsFor, type LootBalance } from '../loot.js';

/**
 * РЕДКОСТЬ ПРИХОДИТ ОТ СЛОЖНОСТИ, а уровень предмета — от участка.
 * GDD §6.2, §7.3 в редакции после тупика.
 *
 * Числа взяты из требования, а не из balance.json: тест обязан ловить
 * расхождение данных с правилом, а сверка данных с ними же его
 * не поймала бы.
 *
 * Потолок каждого тира:
 *   обычная  — редкий, эпика нет нигде;
 *   опасная  — эпик, и только с босса;
 *   кошмар   — эпик с босса гарантированно, плюс шанс легендарки.
 */
const drop = {
  rarityByDifficulty: {
    normal: {
      monster: { common: 62, magic: 30, rare: 8, epic: 0, legendary: 0 },
      boss: { common: 40, magic: 38, rare: 22, epic: 0, legendary: 0 },
    },
    dangerous: {
      monster: { common: 45, magic: 34, rare: 21, epic: 0, legendary: 0 },
      boss: { common: 0, magic: 30, rare: 45, epic: 25, legendary: 0 },
    },
    nightmare: {
      monster: { common: 28, magic: 36, rare: 32, epic: 4, legendary: 0 },
      boss: { common: 0, magic: 0, rare: 0, epic: 100, legendary: 0 },
    },
  },
} as unknown as LootBalance['drop'];

const DIFFICULTIES = ['normal', 'dangerous', 'nightmare'] as const;

const share = (
  difficulty: (typeof DIFFICULTIES)[number],
  isBoss: boolean,
  rarity: Rarity,
): number => {
  const w = rarityWeightsFor(difficulty, isBoss, drop);
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  return (w[rarity] ?? 0) / total;
};

/** Самая высокая редкость с ненулевым весом. */
const ceilingOf = (difficulty: (typeof DIFFICULTIES)[number]): Rarity | null => {
  let out: Rarity | null = null;
  for (const isBoss of [false, true]) {
    const w = rarityWeightsFor(difficulty, isBoss, drop);
    for (const rarity of RARITIES) if ((w[rarity] ?? 0) > 0) out = rarity;
  }
  return out;
};

describe('редкость зависит от сложности', () => {
  it('ПОТОЛОК КАЖДОГО ТИРА — тот, что объявлен', () => {
    expect(ceilingOf('normal')).toBe('rare');
    expect(ceilingOf('dangerous')).toBe('epic');
    // Легендарка выключена нулём, поэтому фактический потолок кошмара
    // сейчас эпик. Что она выключена ИМЕННО нулём — проверка ниже.
    expect(ceilingOf('nightmare')).toBe('epic');
  });

  it('чем выше сложность, тем чаще редкое и реже обычное', () => {
    expect(share('nightmare', false, 'rare')).toBeGreaterThan(share('normal', false, 'rare'));
    expect(share('dangerous', false, 'rare')).toBeGreaterThan(share('normal', false, 'rare'));
    expect(share('nightmare', false, 'common')).toBeLessThan(share('normal', false, 'common'));
  });

  it('УРОВЕНЬ НА РЕДКОСТЬ НЕ ВЛИЯЕТ — подпись это гарантирует', () => {
    /* Проверка на класс ошибки, а не на значение: пока редкость
       считалась от уровня монстра, обе оси были одной, и игрок
       в эпиках ilvl 2 не мог получить эпик ilvl 8. Вернуть уровень
       аргументом значило бы вернуть тупик. */
    expect(rarityWeightsFor.length).toBe(3);
  });

  it('веса неотрицательны и не пусты', () => {
    for (const difficulty of DIFFICULTIES) {
      for (const isBoss of [false, true]) {
        const w = rarityWeightsFor(difficulty, isBoss, drop);
        const total = Object.values(w).reduce((a, b) => a + b, 0);
        expect(total, `${difficulty}/${isBoss}`).toBeGreaterThan(0);
        for (const [rarity, weight] of Object.entries(w)) {
          expect(weight, `${difficulty}/${rarity}`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('неизвестная сложность — отказ, а не тихая таблица по умолчанию', () => {
    expect(() =>
      rarityWeightsFor('такой-сложности-нет' as (typeof DIFFICULTIES)[number], false, drop),
    ).toThrow();
  });
});

describe('эпик только с босса, и только выше обычной сложности', () => {
  it('на обычной эпика нет ни у кого', () => {
    expect(rarityWeightsFor('normal', false, drop).epic).toBe(0);
    expect(rarityWeightsFor('normal', true, drop).epic).toBe(0);
  });

  it('на опасной эпик роняет ТОЛЬКО босс', () => {
    expect(rarityWeightsFor('dangerous', false, drop).epic).toBe(0);
    /* ПАРА К ПРОВЕРКЕ ВЫШЕ. Без неё «эпика нет у рядового» прошло бы
       и на таблице, где эпика нет вообще ни у кого, — то есть
       на сломанной механике. */
    expect(share('dangerous', true, 'epic')).toBeGreaterThan(0.1);
  });

  it('на кошмаре босс роняет эпик ГАРАНТИРОВАННО', () => {
    // Это и есть причина возвращаться на пройденный участок: за эпиком
    // нужного уровня идут не глубже, а на ту же глубину и сложнее.
    expect(share('nightmare', true, 'epic')).toBe(1);
  });

  it('легендарка выключена нулём ВЕЗДЕ — включение правкой одного числа', () => {
    for (const difficulty of DIFFICULTIES) {
      for (const isBoss of [false, true]) {
        expect(
          rarityWeightsFor(difficulty, isBoss, drop).legendary,
          `${difficulty}/${isBoss}`,
        ).toBe(0);
      }
    }
  });
});
