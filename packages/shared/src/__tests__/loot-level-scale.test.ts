import { balance } from '@extramundum/data';
import { ZONES } from '@extramundum/data/zones';
import { describe, expect, it } from 'vitest';

import { enemyLevel, lootLevelScale } from '../zones.js';

/**
 * Затухание оплаты вместе с разницей уровней. GDD §7.3.
 *
 * Проверяется НА НАСТОЯЩИХ данных зон и коэффициентах из
 * `balance.json`: синтетическая зона доказала бы формулу, но не то,
 * что при нынешних числах Пустоши действительно перестают платить.
 */
const CFG = balance.raid.lootLevelScale;
const OFFSET = balance.raid.difficulty.normal.enemyLevelOffset;
const wastes = ZONES.find((z) => z.id === 'wastes')!;

describe('оплата затухает вместе с разницей уровней', () => {
  it('внутри диапазона зоны платится полностью', () => {
    /* Зажим тут НЕ СРАБАТЫВАЕТ, и это главное свойство: разница
       уровней постоянна по всему диапазону, поэтому и оплата
       постоянна. Если бы затухание начиналось внутри диапазона,
       оно наказывало бы за нормальную игру. */
    for (let level = 2; level <= wastes.levels[1] + 1; level++) {
      expect(lootLevelScale(level, OFFSET, wastes, CFG)).toBe(1);
    }
  });

  it('за потолком диапазона падает по ступени за уровень', () => {
    // Потолок Пустошей 8, сдвиг −1: зажим начинает есть с 10 уровня.
    expect(lootLevelScale(10, OFFSET, wastes, CFG)).toBeCloseTo(1 - CFG.perLevel, 10);
    expect(lootLevelScale(11, OFFSET, wastes, CFG)).toBeCloseTo(1 - 2 * CFG.perLevel, 10);
    expect(lootLevelScale(12, OFFSET, wastes, CFG)).toBeCloseTo(1 - 3 * CFG.perLevel, 10);
  });

  it('ниже пола не опускается', () => {
    expect(lootLevelScale(40, OFFSET, wastes, CFG)).toBe(CFG.floor);
    expect(lootLevelScale(400, OFFSET, wastes, CFG)).toBe(CFG.floor);
  });

  it('затухание одностороннее: за спуск в старшую зону надбавки нет', () => {
    const abyss = ZONES.find((z) => z.id === 'abyss')!;
    /* Зажим тут работает ВВЕРХ и работает сильно — иначе проверка
       «надбавки нет» прошла бы и на зоне, где зажим не срабатывает
       вовсе, то есть не доказала бы ничего. */
    expect(enemyLevel(1, OFFSET, abyss)).toBeGreaterThan(1 + OFFSET);
    expect(lootLevelScale(1, OFFSET, abyss, CFG)).toBe(1);
  });

  it('затухание доходит до пола в КАЖДОЙ зоне, кроме последней', () => {
    /* Иначе правило было бы записано для Пустошей и молча не работало
       бы там, где диапазон шире. Последняя зона исключена по своей
       причине: за ней просто нет уровней, до которых можно дорасти. */
    for (const zone of ZONES.slice(0, -1)) {
      const far = zone.levels[1] + 1 + Math.ceil(1 / CFG.perLevel);
      expect(lootLevelScale(far, OFFSET, zone, CFG)).toBe(CFG.floor);
      expect(lootLevelScale(zone.levels[1], OFFSET, zone, CFG)).toBe(1);
    }
  });
});
