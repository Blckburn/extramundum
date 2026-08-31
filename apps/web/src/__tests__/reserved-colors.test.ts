import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { palette } from '@extramundum/data';
import { describe, expect, it } from 'vitest';

import { DECLARATIONS } from './css.ts';

/**
 * ЗАРЕЗЕРВИРОВАННЫЕ ЦВЕТА НЕ ПОПАДАЮТ В ИНТЕРФЕЙС.
 *
 * ART-BIBLE §3: тёплое золото и чистая белизна принадлежат вещам
 * из Мунды. «Не тратить золото на обычный лут. Оно должно быть редким,
 * иначе перестанет значить».
 *
 * Правило существовало текстом с самого появления инвентаря и НИ РАЗУ
 * не применялось: редкость `rare` красилась в `#b08f2c`, то есть
 * побитово в `mundaGold`, и маркер городского происхождения стоял
 * на каждом редком предмете из рейда.
 *
 * Почему это прожило столько времени: тест палитры смотрит
 * на `palette.json` и на риги сцены. CSS не смотрел никто, а игрок
 * видит правило именно там. Проверка обязана стоять там, где живёт
 * то, что она проверяет.
 */
const SPRITE = readFileSync(
  fileURLToPath(new URL('../../public/assets/icons-placeholder.svg', import.meta.url)),
  'utf8',
);

const reserved = Object.entries(palette).filter(([, entry]) => entry.reserved);

/** Все шестнадцатеричные цвета текста, в нижнем регистре. */
function hexesIn(text: string): string[] {
  return [...text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
}

describe('зарезервированные цвета', () => {
  it('в палитре они вообще есть', () => {
    /* Пара к проверкам ниже. Если бы `reserved` оказался пустым —
       например, флаг переименовали, — все проверки прошли бы, ничего
       не проверив, и правило снова стало бы текстом. */
    expect(reserved.length).toBeGreaterThan(0);
    expect(reserved.map(([key]) => key)).toContain('mundaGold');
  });

  it('ни один не встречается в стилях', () => {
    /* Комментарии сняты: цвет, названный в ПРОЗЕ, ничему не назначен.
       Иначе проверка запрещала бы записать историю про золото рядом
       с местом, где оно стояло, — а записана она затем, чтобы этого
       не повторили. */
    const inCss = new Set(hexesIn(DECLARATIONS));
    for (const [key, entry] of reserved) {
      expect(
        inCss.has(entry.hex.toLowerCase()),
        `${key} (${entry.hex}) в styles.css: этот цвет принадлежит вещам из Мунды`,
      ).toBe(false);
    }
  });

  it('ни один не встречается в наборе силуэтов', () => {
    /* Набор нарисован человеком и золота не содержит намеренно —
       проверка на то и стоит, чтобы это не сломалось при следующей
       правке набора. */
    const inSprite = new Set(hexesIn(SPRITE));
    for (const [key, entry] of reserved) {
      expect(
        inSprite.has(entry.hex.toLowerCase()),
        `${key} (${entry.hex}) в icons-placeholder.svg`,
      ).toBe(false);
    }
  });

  it('переменные силуэтов совпадают с палитрой ПОБИТОВО', () => {
    /* Копия палитры в CSS неизбежна — импортировать json оттуда нечем.
       Но копия, которую никто не сверяет, расходится с оригиналом
       молча, а разошедшись, красит игру мимо арт-библии. */
    const pairs: [string, string][] = [
      ['--pal-bone', 'bone'],
      ['--pal-ash', 'ash'],
      ['--pal-ochre', 'ochre'],
      ['--pal-blood', 'blood'],
      ['--pal-bile', 'bile'],
      ['--pal-ink', 'ink'],
    ];
    for (const [variable, key] of pairs) {
      const declared = new RegExp(`${variable}:\\s*(#[0-9a-fA-F]{3,8})`).exec(DECLARATIONS)?.[1];
      expect(declared, `${variable} не объявлена`).toBeDefined();
      expect(declared?.toLowerCase(), `${variable} разошлась с палитрой`).toBe(
        palette[key as keyof typeof palette]?.hex.toLowerCase(),
      );
    }
  });

  it('силуэты красятся переменными, а не своими хексами', () => {
    /* Хексы в наборе есть — как запасные значения `var(..., #hex)`,
       и это правильно: без них иконка исчезнет, если переменную
       забудут объявить. Проверяется, что КАЖДЫЙ хекс стоит именно
       запасным значением, а не отдельной заливкой. */
    const standalone = [...SPRITE.matchAll(/(?:fill|stroke):\s*(#[0-9a-fA-F]{3,8})/g)];
    expect(
      standalone.map((m) => m[0]),
      'цвет задан хексом напрямую, мимо палитры',
    ).toEqual([]);
    expect(SPRITE).toContain('var(--pal-');
  });
});
