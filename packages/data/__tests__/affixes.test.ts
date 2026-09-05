import {
  AFFIX_FAMILIES,
  AFFIX_TIERS,
  EQUIPMENT_SLOTS,
  FLAT_AFFIX_FAMILIES,
  lootBalanceSchema,
  PERCENT_AFFIX_FAMILIES,
  type AffixFamily,
} from '@extramundum/shared';
import { describe, expect, it } from 'vitest';

import { balance } from '../index.ts';

/**
 * Лестницы аффиксов и роли слотов. GDD §5.3, §6.1.
 *
 * Здесь проверяется не баланс — его меряет матрица, — а СОГЛАСОВАННОСТЬ
 * данных с контрактом. Каждая проверка ниже стоит на месте конкретного
 * способа разойтись молча: список в коде против списка в данных, слот
 * без семейств, семейство без слотов, лестница с провалом посередине.
 */

const loot = lootBalanceSchema.parse(balance.items);
const ladders = balance.items.affixFamilies;

/** Середина диапазона тира — по ней сравниваются соседние ступени. */
function mid(family: AffixFamily, tier: (typeof AFFIX_TIERS)[number]): number {
  const range = ladders[family][tier];
  return (range[0] + range[1]) / 2;
}

describe('лестницы аффиксов', () => {
  it('у каждого семейства есть все пять тиров', () => {
    for (const family of AFFIX_FAMILIES) {
      for (const tier of AFFIX_TIERS) {
        const range = ladders[family][tier];
        expect(range, `${family}.${tier}`).toHaveLength(2);
        expect(range[0], `${family}.${tier}: низ выше верха`).toBeLessThanOrEqual(range[1]);
      }
    }
  });

  it('лестница растёт от T5 к T1 без провалов', () => {
    // Провал посередине означал бы, что предмет более высокого тира
    // хуже предыдущего, — то есть прогресс лута перестал читаться.
    for (const family of AFFIX_FAMILIES) {
      const values = ['T5', 'T4', 'T3', 'T2', 'T1'].map((tier) =>
        mid(family, tier as (typeof AFFIX_TIERS)[number]),
      );
      for (let i = 1; i < values.length; i++) {
        expect(values[i], `${family}: T${5 - i} не выше предыдущего`).toBeGreaterThan(
          values[i - 1] ?? 0,
        );
      }
    }
  });

  it('флаг «процентное» в данных совпадает со списком в коде', () => {
    /* ДВА ИСТОЧНИКА ПРАВДЫ, и они обязаны совпадать. Список в коде решает,
       что уйдёт в бойца списком и получит бюджет; флаг в данных решает,
       как генератор округлит значение. Разойдись они — аффикс остался бы
       в тултипе и исчез из боя, а это ровно §13 пункт 4. */
    const percentInData = AFFIX_FAMILIES.filter((family) => ladders[family].percent);
    expect([...percentInData].sort()).toEqual([...PERCENT_AFFIX_FAMILIES].sort());

    const flatInData = AFFIX_FAMILIES.filter((family) => !ladders[family].percent);
    expect([...flatInData].sort()).toEqual([...FLAT_AFFIX_FAMILIES].sort());
  });

  it('бюджет объявлен ровно у процентных семейств', () => {
    expect([...Object.keys(loot.familyBudget)].sort()).toEqual([...PERCENT_AFFIX_FAMILIES].sort());
    for (const family of PERCENT_AFFIX_FAMILIES) {
      expect(loot.familyBudget[family], family).toBeGreaterThanOrEqual(1);
    }
  });

  it('масштаб по ilvl объявлен у всех семейств явно', () => {
    // Умолчание здесь молча обнуляет семейство к высоким уровням,
    // а выглядит это как «аффикс слабоват», а не как забытое поле.
    for (const family of AFFIX_FAMILIES) {
      expect(typeof ladders[family].scalesWithIlvl, family).toBe('boolean');
    }
    // «Сила» — единственное плоское семейство БЕЗ масштаба, потому что
    // её лестница перенесена из GDD §6.1 дословно. Если это изменится,
    // тест обязан упасть: следствие названо в balance.json и в отчёте.
    expect(ladders.strength.scalesWithIlvl).toBe(false);
  });
});

describe('роли слотов', () => {
  it('у каждого слота объявлен непустой список семейств', () => {
    for (const slot of EQUIPMENT_SLOTS) {
      const families = loot.drop.slotFamilies[slot];
      expect(families, `слот «${slot}» без списка семейств`).toBeDefined();
      expect(families?.length ?? 0, slot).toBeGreaterThan(0);
    }
  });

  it('каждое семейство выпадает хотя бы на одном слоте', () => {
    // Семейство без слота — это лестница, которую никто никогда
    // не увидит: числа есть, предметов с ними нет.
    const used = new Set<string>();
    for (const slot of EQUIPMENT_SLOTS) {
      for (const family of loot.drop.slotFamilies[slot] ?? []) used.add(family);
    }
    expect([...used].sort()).toEqual([...AFFIX_FAMILIES].sort());
  });

  it('слоты РАЗЛИЧАЮТСЯ набором семейств, иначе ролей нет', () => {
    /* Ради этого списка защитные семейства и заводились: до M3b кольцо,
       амулет и наручи отличались друг от друга только наличием брони.
       Проверка на то, что три спорных слота действительно разошлись. */
    const key = (slot: (typeof EQUIPMENT_SLOTS)[number]): string =>
      [...(loot.drop.slotFamilies[slot] ?? [])].sort().join(',');

    expect(key('ring')).not.toBe(key('amulet'));
    expect(key('ring')).not.toBe(key('bracers'));
    expect(key('amulet')).not.toBe(key('bracers'));
    expect(key('boots')).not.toBe(key('helmet'));
  });

  it('у каждого семейства из списка слота есть вес выпадения', () => {
    for (const slot of EQUIPMENT_SLOTS) {
      for (const family of loot.drop.slotFamilies[slot] ?? []) {
        expect(loot.drop.familyWeights[family], `${slot} → ${family}`).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * Таблица редкости в НАСТОЯЩИХ данных, а не в тестовой копии.
 *
 * Правило проверяется дважды и в разных местах намеренно: тест
 * в `packages/shared` держит саму функцию против требования на своей
 * таблице, этот — держит `balance.json` против того же требования.
 * Одного мало: функция может быть верной на данных, которые нарушают
 * правило, и наоборот.
 */
describe('редкость по сложностям — настоящие данные', () => {
  const table = loot.drop.rarityByDifficulty;

  it('таблица есть на все три сложности, и рядовым отдельно от босса', () => {
    for (const difficulty of ['normal', 'dangerous', 'nightmare'] as const) {
      expect(table[difficulty], difficulty).toBeDefined();
      expect(Object.keys(table[difficulty] ?? {}).sort()).toEqual(['boss', 'monster']);
    }
  });

  it('ПОТОЛОК ТИРА совпадает с объявленным в §7.3', () => {
    const has = (difficulty: 'normal' | 'dangerous' | 'nightmare', who: 'monster' | 'boss') =>
      Object.entries(table[difficulty]?.[who] ?? {})
        .filter(([, weight]) => weight > 0)
        .map(([rarity]) => rarity);

    // Обычная: эпика нет нигде.
    expect(has('normal', 'monster')).not.toContain('epic');
    expect(has('normal', 'boss')).not.toContain('epic');
    // Опасная: эпик ТОЛЬКО с босса.
    expect(has('dangerous', 'monster')).not.toContain('epic');
    expect(has('dangerous', 'boss')).toContain('epic');
    // Кошмар: босс роняет эпик и ничего кроме — то есть гарантированно.
    expect(has('nightmare', 'boss')).toEqual(['epic']);
  });

  it('редкое встречается тем чаще, чем выше сложность', () => {
    /* Пара к проверке потолка: «эпика нет на обычной» верно и для
       таблицы, где сложность не меняет вообще ничего. Оси обязаны
       различаться на всём диапазоне, а не только на верхней ступени. */
    const rareShare = (difficulty: 'normal' | 'dangerous' | 'nightmare') => {
      const w = table[difficulty]?.monster ?? {};
      const total = Object.values(w).reduce((a, b) => a + b, 0);
      return (w.rare ?? 0) / total;
    };
    expect(rareShare('dangerous')).toBeGreaterThan(rareShare('normal'));
    expect(rareShare('nightmare')).toBeGreaterThan(rareShare('dangerous'));
  });

  it('легендарка выключена нулём во всех шести строках', () => {
    for (const difficulty of ['normal', 'dangerous', 'nightmare'] as const) {
      for (const who of ['monster', 'boss'] as const) {
        expect(table[difficulty]?.[who]?.legendary, `${difficulty}/${who}`).toBe(0);
      }
    }
  });
});
