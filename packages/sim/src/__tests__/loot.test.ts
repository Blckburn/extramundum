import { balance as balanceData, ITEM_BASES } from '@extramundum/data';
import { lootBalanceSchema, RARITIES, type Rarity } from '@extramundum/shared';
import { describe, expect, it } from 'vitest';

import { allowedTiers, generateItem } from '../loot.js';

/**
 * Генерация лута. GDD §6.1, §6.2.
 *
 * Проверяется то, что обещано в брифе M3a: детерминизм, потолок тира
 * по ilvl, число аффиксов по редкости.
 */

const loot = lootBalanceSchema.parse(balanceData.items);
const bases = ITEM_BASES;

const make = (seed: string, ilvl = 20, rarity?: Rarity) =>
  generateItem(seed, rarity === undefined ? { ilvl } : { ilvl, rarity }, loot, bases);

describe('детерминизм', () => {
  it('один сид и один вход дают побитово тот же предмет', () => {
    for (const seed of ['a', 'зеро', 'raid:1:42']) {
      expect(make(seed)).toEqual(make(seed));
    }
  });

  it('разные сиды дают РАЗНЫЕ предметы', () => {
    // Без этой проверки «детерминизм» выполнялся бы и генератором,
    // который всегда возвращает одно и то же.
    const items = new Set<string>();
    for (let i = 0; i < 200; i++) items.add(JSON.stringify(make(`seed-${i}`)));
    expect(items.size).toBeGreaterThan(100);
  });

  it('не зависит от порядка вызовов', () => {
    const first = make('x');
    make('y');
    make('z');
    expect(make('x')).toEqual(first);
  });
});

describe('тир не превышает допустимый для ilvl', () => {
  it('на каждом уровне ни один аффикс не выше разрешённого', () => {
    for (const ilvl of [1, 7, 8, 15, 16, 24, 25, 33, 34, 60]) {
      const allowed = new Set(allowedTiers(ilvl, loot));
      let seen = 0;

      for (let i = 0; i < 300; i++) {
        const item = generateItem(`t-${ilvl}-${i}`, { ilvl, rarity: 'epic' }, loot, bases);
        for (const affix of item.affixes) {
          expect(allowed.has(affix.tier), `ilvl ${ilvl} выдал ${affix.tier}`).toBe(true);
          seen++;
        }
      }

      // Аффиксы обязаны были выпасть: проверка «ни один не выше»
      // проходит и на предмете без аффиксов вовсе.
      expect(seen).toBeGreaterThan(1000);
    }
  });

  it('на первом уровне доступен только T5, на 34-м — все пять', () => {
    expect(allowedTiers(1, loot)).toEqual(['T5']);
    expect(allowedTiers(34, loot)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    // Границы включительно: T4 требует ilvl 8, значит на 7 его ещё нет.
    expect(allowedTiers(7, loot)).toEqual(['T5']);
    expect(allowedTiers(8, loot)).toEqual(['T4', 'T5']);
  });

  it('высокий тир РЕАЛЬНО выпадает там, где разрешён', () => {
    // Иначе потолок соблюдался бы генератором, который всегда даёт T5.
    const tiers = new Set<string>();
    for (let i = 0; i < 400; i++) {
      for (const affix of generateItem(`hi-${i}`, { ilvl: 40, rarity: 'epic' }, loot, bases)
        .affixes) {
        tiers.add(affix.tier);
      }
    }
    expect([...tiers].sort()).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
  });
});

describe('число аффиксов соответствует редкости', () => {
  it('каждая редкость держится своего диапазона', () => {
    for (const rarity of RARITIES) {
      const [min, max] = loot.affixCountByRarity[rarity] ?? [0, 0];
      const counts = new Set<number>();

      for (let i = 0; i < 200; i++) {
        const item = make(`r-${rarity}-${i}`, 40, rarity);
        expect(item.rarity).toBe(rarity);
        expect(item.affixes.length).toBeGreaterThanOrEqual(min);
        expect(item.affixes.length).toBeLessThanOrEqual(max);
        counts.add(item.affixes.length);
      }

      // Диапазон обязан покрываться целиком: генератор, всегда дающий
      // минимум, тоже «держится диапазона».
      expect([...counts].sort((a, b) => a - b)).toEqual(
        Array.from({ length: max - min + 1 }, (_, i) => min + i),
      );
    }
  });

  it('легендарка — ЧЕТЫРЕ аффикса, как в GDD §6.2', () => {
    for (let i = 0; i < 50; i++) {
      expect(make(`leg-${i}`, 40, 'legendary').affixes).toHaveLength(4);
    }
  });
});

describe('легендарки не выпадают в M3a', () => {
  it('вес ноль — значит ни одной на большой выборке', () => {
    // Решение человека: пока уникальный модификатор отложен, легендарка
    // на четыре аффикса слабее эпика на пять, и отгружать такую лестницу
    // редкости нельзя. Генератор их умеет — тест выше это доказывает,
    // — но по весам они не приходят.
    let legendary = 0;
    let epic = 0;
    for (let i = 0; i < 5000; i++) {
      const rarity = make(`w-${i}`, 40).rarity;
      if (rarity === 'legendary') legendary++;
      if (rarity === 'epic') epic++;
    }
    expect(legendary).toBe(0);
    // И выборка живая: эпики в ней есть, то есть редкости вообще катаются.
    expect(epic).toBeGreaterThan(50);
  });
});

describe('база предмета', () => {
  it('выпадает только та, что разрешена уровнем', () => {
    for (const ilvl of [1, 8, 16]) {
      for (let i = 0; i < 300; i++) {
        const item = generateItem(`b-${ilvl}-${i}`, { ilvl }, loot, bases);
        const base = bases.find((b) => b.key === item.baseKey);
        expect(base, `база «${item.baseKey}» неизвестна`).toBeDefined();
        expect(base?.minIlvl ?? 1).toBeLessThanOrEqual(ilvl);
        expect(item.slot).toBe(base?.slot);
      }
    }
  });

  it('слот можно задать, и тогда выпадает только он', () => {
    for (let i = 0; i < 100; i++) {
      expect(generateItem(`s-${i}`, { ilvl: 30, slot: 'boots' }, loot, bases).slot).toBe('boots');
    }
  });

  it('на первом уровне доступны не все базы, на сороковом — все', () => {
    // Свойство minIlvl должно РАБОТАТЬ, а не просто существовать в схеме.
    const low = new Set<string>();
    const high = new Set<string>();
    for (let i = 0; i < 800; i++) {
      low.add(generateItem(`l-${i}`, { ilvl: 1 }, loot, bases).baseKey);
      high.add(generateItem(`h-${i}`, { ilvl: 40 }, loot, bases).baseKey);
    }
    expect(low.size).toBeLessThan(high.size);
    expect(high.size).toBe(bases.length);
  });
});

describe('уникальный модификатор', () => {
  it('всегда null — в M3a их не существует', () => {
    for (let i = 0; i < 100; i++) {
      expect(make(`u-${i}`, 40, 'legendary').uniqueModifier).toBeNull();
    }
  });
});
