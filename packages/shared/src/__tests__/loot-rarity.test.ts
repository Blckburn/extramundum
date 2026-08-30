import { describe, expect, it } from 'vitest';

import { rarityWeightsFor, type LootBalance } from '../loot.js';

/**
 * Редкость приходит от СИЛЫ ВРАГА. GDD §6.2.
 *
 * Числа взяты из требования, а не из balance.json: тест обязан ловить
 * расхождение данных с правилом, а сверка данных с ними же его
 * не поймала бы.
 */
const drop = {
  rarityByLevel: {
    common: { base: 62, perLevel: -1.2 },
    magic: { base: 30, perLevel: 0 },
    rare: { base: 8, perLevel: 1.2 },
    epic: { base: 0, perLevel: 0 },
    legendary: { base: 0, perLevel: 0 },
  },
  bossRarityBonus: { common: 0, magic: 0, rare: 0, epic: 25, legendary: 0 },
} as unknown as LootBalance['drop'];

const share = (level: number, isBoss: boolean, rarity: 'common' | 'rare' | 'epic'): number => {
  const w = rarityWeightsFor(level, isBoss, drop);
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  return (w[rarity] ?? 0) / total;
};

describe('редкость зависит от уровня монстра', () => {
  it('чем сильнее враг, тем чаще редкое и реже обычное', () => {
    expect(share(24, false, 'rare')).toBeGreaterThan(share(8, false, 'rare'));
    expect(share(24, false, 'common')).toBeLessThan(share(8, false, 'common'));
  });

  it('вес не уходит в минус на глубоких зонах', () => {
    // common: 62 − 1.2 × 40 = 14 на сороковом, но на «сотом» ушёл бы
    // в минус, а минус во взвешенном выборе — это не «реже», а сдвиг
    // всей выборки.
    const w = rarityWeightsFor(100, false, drop);
    for (const [rarity, weight] of Object.entries(w)) {
      expect(weight, rarity).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('эпик только с босса', () => {
  it('обычный монстр не роняет эпик НИ НА КАКОМ уровне', () => {
    for (const level of [1, 8, 16, 24, 32, 40]) {
      expect(rarityWeightsFor(level, false, drop).epic, `уровень ${level}`).toBe(0);
    }
  });

  it('а босс роняет — и это видно', () => {
    // ПАРА К ПРОВЕРКЕ ВЫШЕ. Без неё «эпика нет» прошло бы и на таблице,
    // где эпика нет вообще ни у кого, — то есть на сломанной механике.
    expect(share(8, true, 'epic')).toBeGreaterThan(0.1);
  });

  it('легендарка выключена нулём у всех, включая босса', () => {
    expect(rarityWeightsFor(40, true, drop).legendary).toBe(0);
    expect(rarityWeightsFor(40, false, drop).legendary).toBe(0);
  });
});
