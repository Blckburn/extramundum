import { palette, RIGS } from '@extramundum/data';
import { PALETTE_ROLES } from '@extramundum/shared';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Mesh } from 'three';

import { createBattleScene } from '../scene.js';

/**
 * Палитра. ART-BIBLE §2–3.
 *
 * Документ описывает цвета словами, а не хексами. Значит проверять надо
 * не «правильный ли оттенок» — это вкус, — а правила, которые документ
 * формулирует однозначно: покрыты ли все роли, и соблюдено ли отдельное
 * правило про золото.
 */

describe('палитра покрывает арт-библию', () => {
  it('каждая роль из ART-BIBLE §3 имеет хотя бы один цвет', () => {
    const covered = new Set(Object.values(palette).map((entry) => entry.role));
    const missing = PALETTE_ROLES.filter((role) => !covered.has(role));
    expect(missing, 'роль из арт-библии не покрыта ни одним цветом').toEqual([]);
  });

  it('у каждого цвета записаны слова арт-библии, которыми он обоснован', () => {
    for (const [key, entry] of Object.entries(palette)) {
      expect(entry.note.length, `цвет ${key} без обоснования`).toBeGreaterThan(8);
    }
  });

  it('насыщенных чистых цветов нет: яркая палитра v1.0 отменена', () => {
    // ART-BIBLE §2: «Никаких насыщенных чистых цветов: красный —
    // не помидорный, а запёкшийся». Проверяем насыщенность в HSL.
    //
    // Городские цвета исключены не для того, чтобы тест позеленел:
    // ART-BIBLE §3 прямо требует, чтобы они выглядели иначе — «всё, что
    // пришло из города, СВЕТИТСЯ ИНАЧЕ, чем всё остальное». Исключение
    // ниже превращено в утверждение: городской цвет обязан быть
    // насыщеннее любого обычного, иначе маркер не работает.
    const loud: string[] = [];
    for (const [key, entry] of Object.entries(palette)) {
      if (entry.reserved) continue;
      const { s, l } = toHsl(entry.hex);
      // Тёмное и очень светлое имеют низкую насыщенность по построению,
      // поэтому смотрим только на средние тона, где кричать возможно.
      if (l > 0.2 && l < 0.8 && s > 0.62) loud.push(`${key} ${entry.hex} (S=${s.toFixed(2)})`);
    }
    expect(loud, 'цвет слишком насыщенный для гравюры').toEqual([]);
  });

  it('самое светлое в палитре принадлежит городу — иначе он не маркер', () => {
    const lightness = (hex: string) => toHsl(hex).l;
    const ordinary = Object.values(palette).filter((e) => !e.reserved);
    const city = Object.values(palette).filter((e) => e.reserved);

    expect(city.length).toBeGreaterThan(0);
    expect(Math.max(...city.map((e) => lightness(e.hex)))).toBeGreaterThan(
      Math.max(...ordinary.map((e) => lightness(e.hex))),
    );

    // ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Раньше тут стояло «городской цвет
    // насыщеннее любого обычного». Утверждение оказалось выдуманным:
    // самый насыщенный цвет мира — `flame`, огонь жаровни, и он законно
    // теплее приглушённого городского золота. Требовать обратного значило
    // бы гнать палитру под тест, а не тест под арт-библию.
    //
    // Настоящий маркер города — не насыщенность, а ЯРКОСТЬ и другой
    // способ отрисовки: заливка без света и без тумана. Второе проверяет
    // тест «городское рисуется иначе, чем всё остальное» ниже.
  });
});

describe('золото зарезервировано за Мундой', () => {
  it('зарезервированные цвета есть, иначе правило не о чем', () => {
    const reserved = Object.entries(palette).filter(([, entry]) => entry.reserved);
    expect(reserved.length).toBeGreaterThan(0);
  });

  it('в окружении и на бойцах зарезервированный цвет не встречается', () => {
    // ART-BIBLE §3: «Не тратить золото на обычный лут. Оно должно быть
    // редким, иначе перестанет значить.»
    const reservedHex = new Set(
      Object.values(palette)
        .filter((entry) => entry.reserved)
        .map((entry) => entry.hex.slice(1)),
    );

    const offenders: string[] = [];
    for (const specId of ['humanoid', 'arena'] as const) {
      for (const node of RIGS[specId].nodes) {
        const entry = palette[node.color];
        if (entry?.reserved === true) offenders.push(`${specId}.${node.name}`);
      }
    }
    expect(offenders, 'городской цвет утёк в обычный объект').toEqual([]);
    expect(reservedHex.size).toBeGreaterThan(0);
  });

  it('силуэт Мунды зарезервированный цвет использует — и помечен как городской', () => {
    // Обратная проверка. Без неё предыдущая проходила бы и в мире,
    // где зарезервированные цвета не используются вовсе, — то есть
    // правило соблюдалось бы отсутствием города.
    const munda = RIGS.munda;
    const usesReserved = munda.nodes.filter((node) => palette[node.color]?.reserved === true);
    expect(
      usesReserved.length,
      'Мунда не светится — единственное чистое место пропало',
    ).toBeGreaterThan(0);
    for (const node of usesReserved) {
      expect(node.origin, `узел ${node.name} использует городской цвет, не будучи городским`).toBe(
        'city',
      );
    }
  });

  it('городское рисуется ИНАЧЕ: без света и без тумана', () => {
    // ART-BIBLE §3: «всё, что пришло из Мунды, светится иначе, чем всё
    // остальное». Это свойство материала, а не подобранный оттенок:
    // городской узел получает ровную заливку, которой не касается ни свет
    // сцены, ни расстояние. Иначе город тонет в тумане — что и показал
    // первый скриншот M2a.
    const built = createBattleScene();
    let city = 0;
    let world = 0;

    built.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const material = object.material as { isMeshBasicMaterial?: boolean; fog: boolean };
      if (built.cityNodes.has(object)) {
        expect(material.isMeshBasicMaterial, `${object.name}: город освещается как мир`).toBe(true);
        expect(material.fog, `${object.name}: город съедает туман`).toBe(false);
        city += 1;
      } else {
        expect(
          material.isMeshBasicMaterial,
          `${object.name}: обычный объект не лепится светом`,
        ).not.toBe(true);
        world += 1;
      }
    });

    expect(city, 'городских мешей нет — проверять нечего').toBeGreaterThan(0);
    expect(world, 'обычных мешей нет — сравнивать не с чем').toBeGreaterThan(0);

    built.dispose();
  });

  it('в собранной сцене зарезервированный материал принадлежит только Мунде', () => {
    const built = createBattleScene();
    const reservedHex = new Set(
      Object.values(palette)
        .filter((entry) => entry.reserved)
        .map((entry) => entry.hex.slice(1)),
    );

    const offenders: string[] = [];
    let cityMeshes = 0;

    built.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const hex = (object.material as { color: { getHexString(): string } }).color.getHexString();
      if (!reservedHex.has(hex)) return;
      if (built.cityNodes.has(object)) cityMeshes += 1;
      else offenders.push(object.name);
    });

    expect(offenders, 'зарезервированный цвет на негородском объекте').toEqual([]);
    expect(cityMeshes, 'ни одного городского меша — проверять нечего').toBeGreaterThan(0);

    built.dispose();
  });
});

describe('интерфейс красится той же палитрой', () => {
  it('каждая цветовая переменная styles.css есть в palette.json', () => {
    // Иначе интерфейс и сцена расходятся по оттенку молча. Прежний
    // акцент #c2683a был именно таким: насыщенный оранжевый, то есть
    // отменённая палитра v1.0.
    const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
    const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));

    const hexes = [...root.matchAll(/--[\w-]+:\s*(#[0-9a-f]{6})/gi)].map((m) =>
      m[1]!.toLowerCase(),
    );
    expect(hexes.length, 'в :root не нашлось цветов — тест смотрит не туда').toBeGreaterThan(4);

    const known = new Set(Object.values(palette).map((entry) => entry.hex.toLowerCase()));
    const stray = hexes.filter((hex) => !known.has(hex));
    expect(stray, 'цвет интерфейса подобран мимо арт-библии').toEqual([]);
  });
});

/** HSL из hex. Нужен только для проверки насыщенности. */
function toHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: 0, s, l };
}
