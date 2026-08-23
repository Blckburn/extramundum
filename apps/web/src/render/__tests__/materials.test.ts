import { RIGS } from '@extramundum/data';
import { describe, expect, it } from 'vitest';
import { Mesh } from 'three';

import { measureScene } from '../budget.js';
import { MaterialCache } from '../materials.js';
import { buildRig, GeometryCache } from '../rig.js';
import { createBattleScene } from '../scene.js';

/**
 * Кэш материалов. GDD §3.4 и §13, пункт 19.
 *
 * «`material.clone()` на каждом меше — сотни материалов на двух бойцов».
 * Здесь проверяется, что материалов ровно столько, сколько РАЗЛИЧНЫХ
 * цветов, а не столько, сколько мешей.
 */

describe('кэш материалов', () => {
  it('один цвет — один материал, сколько бы раз его ни просили', () => {
    const cache = new MaterialCache();
    const first = cache.get('#112233');
    const again = cache.get('#112233');
    const other = cache.get('#445566');

    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(cache.size).toBe(2);
  });

  it('в собранной сцене материалов кратно меньше, чем мешей', () => {
    const built = createBattleScene();
    const budget = measureScene(built.scene);

    // Сама суть правки: 75 мешей на 10 материалов, а не 75 на 75.
    expect(budget.meshes).toBeGreaterThan(40);
    expect(budget.materials).toBeLessThan(budget.meshes / 3);
    expect(budget.materials).toBe(built.materials.size);

    built.dispose();
  });

  it('два бойца из одной спецификации делят материалы, а не удваивают их', () => {
    // Прямая проверка против v1.0: там второй боец давал второй набор.
    const materials = new MaterialCache();
    const geometries = new GeometryCache();

    buildRig(RIGS.humanoid, materials, geometries);
    const afterFirst = materials.size;
    buildRig(RIGS.humanoid, materials, geometries);

    expect(afterFirst).toBeGreaterThan(0);
    expect(materials.size).toBe(afterFirst);
  });

  it('меши ссылаются на общий экземпляр материала, а не на копию', () => {
    // `.clone()` дал бы разные объекты с одинаковым цветом — и тест
    // на «число материалов» его бы поймал, а этот ловит саму подмену.
    const materials = new MaterialCache();
    const geometries = new GeometryCache();
    const rig = buildRig(RIGS.humanoid, materials, geometries);

    const byColor = new Map<string, unknown[]>();
    for (const node of rig.nodes.values()) {
      if (!(node instanceof Mesh)) continue;
      const hex = (node.material as { color: { getHexString(): string } }).color.getHexString();
      const list = byColor.get(hex) ?? [];
      list.push(node.material);
      byColor.set(hex, list);
    }

    const shared = [...byColor.values()].filter((list) => list.length > 1);
    expect(shared.length, 'ни один цвет не повторяется — проверять нечего').toBeGreaterThan(0);
    for (const list of shared) {
      for (const material of list) expect(material).toBe(list[0]);
    }
  });

  it('геометрии тоже кэшируются: одинаковые коробки — одна геометрия', () => {
    const geometries = new GeometryCache();
    const a = geometries.get(1, 2, 3);
    const b = geometries.get(1, 2, 3);
    const c = geometries.get(1, 2, 4);

    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(geometries.size).toBe(2);
  });
});
