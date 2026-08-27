import { describe, expect, it } from 'vitest';

import {
  atkMultiplier,
  critChance,
  dodgeChance,
  ilvlScale,
  matchupMultiplier,
  maxHp,
  mitigation,
} from '../fighter.js';
import { balance, fighter } from './helpers.js';

/**
 * Формулы против текста GDD §4.2 и §4.3.
 *
 * Каждый тест сверяет результат с ЧИСЛОМ ИЗ ДОКУМЕНТА, а не с тем, что
 * вернул код. Иначе это тест «функция возвращает то, что возвращает» —
 * ровно та пустота, из-за которой в v1.0 шесть трейтов описывали одно,
 * а делали другое.
 */

describe('максимум HP (GDD §4.2: 60 + DEF × 6 + уровень × 14 + бонусы_путей)', () => {
  it('складывается по формуле', () => {
    const config = fighter({ level: 10, def: 20 });
    // 60 + 20×6 + 10×14 = 60 + 120 + 140 = 320
    expect(maxHp(config, balance)).toBe(320);
  });

  it('бонусы путей ПРИБАВЛЯЮТСЯ, а не выводятся из уровня', () => {
    const base = fighter({ level: 10, def: 20 });
    const guardian = fighter({ level: 10, def: 20, pathBonusHp: 20 });
    const iron = fighter({ level: 10, def: 20, pathBonusHp: 15 });
    const titan = fighter({ level: 10, def: 20, pathBonusHp: 30 });

    // GDD §13, пункт 2: в v1.0 applyEquippedToFighter пересчитывал maxHp
    // по формуле и стирал ровно эти бонусы.
    expect(maxHp(guardian, balance)).toBe(maxHp(base, balance) + 20);
    expect(maxHp(iron, balance)).toBe(maxHp(base, balance) + 15);
    expect(maxHp(titan, balance)).toBe(maxHp(base, balance) + 30);
  });

  it('пересчёт по той же конфигурации не теряет бонус путей', () => {
    // Единственная функция, считающая максимум HP, — maxHp. Повторный
    // вызов обязан давать то же число: в v1.0 второй вызов давал меньше.
    const config = fighter({ level: 12, def: 18, pathBonusHp: 30 });
    const first = maxHp(config, balance);
    const second = maxHp(config, balance);

    expect(second).toBe(first);
    expect(first).toBeGreaterThan(maxHp({ ...config, pathBonusHp: 0 }, balance));
  });
});

describe('уклонение (§4.2 после M3b: clamp(0.03 + AGI × 0.008, 0, 0.30) − ACC × 0.008)', () => {
  it('пример из документа: AGI 20 против ACC 8 → 12.6%', () => {
    expect(dodgeChance(20, 8, balance)).toBeCloseTo(0.126, 10);
  });

  it('точность вычитается из уклонения защитника', () => {
    expect(dodgeChance(20, 0, balance)).toBeCloseTo(0.19, 10);
    expect(dodgeChance(20, 20, balance)).toBeCloseTo(0.03, 10);
  });

  it('кап 30% сверху и 0% снизу', () => {
    expect(dodgeChance(1000, 0, balance)).toBe(0.3);
    expect(dodgeChance(0, 1000, balance)).toBe(0);
  });

  /**
   * ПОРЯДОК ПОТОЛКА И ВЫЧИТАНИЯ — вся механика точности.
   *
   * Прежняя формула клампила РАЗНОСТЬ, и точность из-за этого работала
   * ступенькой: при высокой ловкости защитника разность упиралась
   * в потолок, и первые тридцать единиц точности не делали ровно
   * ничего. Замерено на 34-м уровне: эффективная точность +4…+30 давала
   * 49–54% побед, то есть шум вокруг половины, а +45 давала 70%.
   * Четыре нижних тира «Верности руки» были мертвы.
   */
  describe('потолок применяется к уклонению, а точность вычитается ПОСЛЕ него', () => {
    it('каждая единица точности снимает свою долю даже за потолком', () => {
      // AGI 1000 — уклонение заведомо у потолка 0.30.
      const capped = dodgeChance(1000, 0, balance);
      expect(capped).toBe(0.3);

      // И точность работает ОТСЮДА, а не с недостижимой разности.
      expect(dodgeChance(1000, 10, balance)).toBeCloseTo(0.3 - 10 * 0.008, 10);
      expect(dodgeChance(1000, 20, balance)).toBeCloseTo(0.3 - 20 * 0.008, 10);
    });

    it('шаг точности ОДИНАКОВ у защитника за потолком и под ним', () => {
      /* Это и есть «кусает всегда»: разница между 10 и 20 единицами
         точности одна и та же, от какой бы ловкости ни начинали.
         На прежней формуле у бойца за потолком она была нулевой. */
      const overCap = dodgeChance(1000, 10, balance) - dodgeChance(1000, 20, balance);
      const underCap = dodgeChance(20, 10, balance) - dodgeChance(20, 20, balance);

      expect(overCap).toBeCloseTo(underCap, 10);
      // И шаг НЕ НОЛЬ: иначе равенство выполнялось бы и на формуле,
      // где точность не делает ничего вообще.
      expect(overCap).toBeGreaterThan(0);
    });

    it('мёртвой зоны нет: соседние значения точности дают разное', () => {
      // Ровно те числа, на которых замер показывал плато.
      const values = [4, 12, 20, 30, 45].map((acc) => dodgeChance(70, acc, balance));
      for (let i = 1; i < values.length; i += 1) {
        expect(values[i]!, `точность ${[4, 12, 20, 30, 45][i]}`).toBeLessThan(values[i - 1]!);
      }
    });

    it('уклонение не уходит ниже нуля', () => {
      // Иначе точность превратилась бы в прибавку к урону.
      expect(dodgeChance(0, 1000, balance)).toBe(0);
      expect(dodgeChance(70, 1000, balance)).toBe(0);
    });
  });
});

describe('крит (GDD §4.2: 0.05 + AGI × 0.004, кап 60%)', () => {
  it('пример из документа: AGI 20 → 13%', () => {
    expect(critChance(20, 0, balance)).toBeCloseTo(0.13, 10);
  });

  it('бонусы аффиксов складываются сверх формулы', () => {
    expect(critChance(20, 0.1, balance)).toBeCloseTo(0.23, 10);
  });

  it('кап 60%', () => {
    expect(critChance(1000, 1, balance)).toBe(0.6);
  });
});

describe('митигация (GDD §4.2: ARM/(ARM+40+12×lvl), кап 75%)', () => {
  it('пример из документа: ARM 100, уровень 10 → 38%', () => {
    // 100 / (100 + 40 + 120) = 100/260 = 0.3846…
    expect(mitigation(100, 10, balance)).toBeCloseTo(0.3846, 4);
    expect(Math.round(mitigation(100, 10, balance) * 100)).toBe(38);
  });

  it('уровень берётся у АТАКУЮЩЕГО: та же броня хуже держит сильного', () => {
    expect(mitigation(100, 40, balance)).toBeLessThan(mitigation(100, 1, balance));
  });

  it('кап 75% даже при огромной броне', () => {
    expect(mitigation(1_000_000, 1, balance)).toBe(0.75);
  });

  it('без брони митигации нет', () => {
    expect(mitigation(0, 10, balance)).toBe(0);
  });
});

describe('множитель ATK (GDD §4.2: 1 + ATK/60)', () => {
  it('ATK умножает урон, а не прибавляется к нему', () => {
    expect(atkMultiplier(0, balance)).toBe(1);
    expect(atkMultiplier(60, balance)).toBe(2);
    expect(atkMultiplier(30, balance)).toBe(1.5);
  });
});

describe('масштаб уровня предмета (GDD §6.1: 1 + ilvl × 0.04)', () => {
  it('считается по формуле', () => {
    expect(ilvlScale(1, balance)).toBeCloseTo(1.04, 10);
    expect(ilvlScale(25, balance)).toBeCloseTo(2, 10);
  });
});

describe('матчапы (GDD §4.3, таблица целиком)', () => {
  // Таблица переписана из документа вручную. Если кто-то поправит
  // balance.json «на глаз», разойдётся именно здесь.
  const expected: Record<string, Record<string, number>> = {
    light: { cloth: 1.15, light: 1.1, medium: 1.0, heavy: 0.85 },
    balanced: { cloth: 1.0, light: 1.05, medium: 1.05, heavy: 1.0 },
    heavy: { cloth: 0.9, light: 0.9, medium: 1.05, heavy: 1.2 },
  };

  for (const [weapon, row] of Object.entries(expected)) {
    for (const [armor, value] of Object.entries(row)) {
      it(`${weapon} против ${armor} → ×${value}`, () => {
        expect(
          matchupMultiplier(
            weapon as 'light' | 'balanced' | 'heavy',
            armor as 'cloth' | 'light' | 'medium' | 'heavy',
            balance,
          ),
        ).toBeCloseTo(value, 10);
      });
    }
  }

  it('лёгкое оружие лучше против ткани, тяжёлое — против тяжёлой брони', () => {
    // Смысл камня-ножниц-бумаги: против конкретного врага есть
    // правильное и неправильное снаряжение (GDD §4.3).
    expect(matchupMultiplier('light', 'cloth', balance)).toBeGreaterThan(
      matchupMultiplier('heavy', 'cloth', balance),
    );
    expect(matchupMultiplier('heavy', 'heavy', balance)).toBeGreaterThan(
      matchupMultiplier('light', 'heavy', balance),
    );
  });

  it('пустая клетка таблицы — ошибка, а не молчаливая единица', () => {
    const broken = { ...balance, matchup: { light: {} } } as unknown as typeof balance;
    expect(() => matchupMultiplier('light', 'cloth', broken)).toThrow(/matchup/);
  });
});
