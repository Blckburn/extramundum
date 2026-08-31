import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Правила интерфейса из брифа — по исходнику CSS.
 *
 * Проверять их в браузере было бы честнее, но у нас нет ни jsdom
 * (окружение тестов — `node`), ни живого лейаута в CI. Источник же
 * поймает ровно то, что ломается на практике: правило, которое стёрли,
 * и правило, которое перекрыли вторым определением.
 *
 * Второе — не теория. `.button--small` был объявлен в файле ДВАЖДЫ
 * с разными отступами, побеждало нижнее, и половина видимого правила
 * не действовала.
 */
import { blocksWith, CSS as css, soleBlocks } from './css.ts';

const ts = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../screens/${name}.ts`, import.meta.url)), 'utf8');

/** Значение токена из :root. */
function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  expect(match, `токен --${name} не объявлен`).not.toBeNull();
  return (match?.[1] ?? '').trim();
}

describe('размеры целей нажатия', () => {
  it('токен цели не меньше 48 пикселей', () => {
    /* Сходятся Apple 44 pt, Material 48 dp и WCAG 2.1 — 44 CSS-пикселя.
       Берём большее: разница не стоит выбора между платформами. */
    const value = token('tap');
    expect(value).toMatch(/px$/);
    expect(Number.parseFloat(value)).toBeGreaterThanOrEqual(48);
  });

  it('расстояние между соседними целями не меньше 8 пикселей', () => {
    /* Цели в плотных списках воруют касания у соседей, и лечится это
       расстоянием чаще, чем размером. */
    const value = token('tap-gap');
    const px = value.endsWith('rem') ? Number.parseFloat(value) * 16 : Number.parseFloat(value);
    expect(px).toBeGreaterThanOrEqual(8);
  });

  it('минимум применён к РОЛЯМ, а не к перечню классов экрана', () => {
    /* Правило обязано действовать и на элемент, который заведут
       завтра. Список имён классов такого не даёт — он про вчера. */
    const rule = /([^}]*?)\{[^}]*min-height:\s*var\(--tap\)/.exec(css);
    expect(rule, 'нет правила с min-height: var(--tap)').not.toBeNull();
    const selectors = rule?.[1] ?? '';
    expect(selectors).toContain('button');
    expect(selectors).toContain('select');
  });

  const TAP_ROWS = ['.inv__grid', '.inv__slots', '.zone__difficulties', '.raid__actions'];

  it('ряды целей получают минимальный зазор', () => {
    for (const row of TAP_ROWS) {
      const bodies = blocksWith(row).join('\n');
      expect(bodies, `ряд ${row} без зазора`).toContain('gap: var(--tap-gap)');
    }
  });

  it('зазор НЕ ПЕРЕКРЫТ собственным правилом ряда ниже по файлу', () => {
    /* Тест первой редакции проверял, что правило с зазором СУЩЕСТВУЕТ,
       и был зелёным — а браузер показывал 5.6 пикселя вместо восьми:
       у `.inv__grid` ниже по файлу стоял свой `gap`, и побеждал он.

       Это ровно та болезнь, из-за которой в файле было два
       `.button--small`. Проверка «правило есть» её не видит
       по построению: надо проверять, что правило ПОБЕЖДАЕТ. */
    for (const row of TAP_ROWS) {
      const own = blocksWith(row).filter((body) => /gap:/.test(body));
      const competing = own.filter((body) => !body.includes('gap: var(--tap-gap)'));
      expect(competing, `у ${row} есть свой gap, перекрывающий общий`).toHaveLength(0);
    }
  });

  it('квадратным целям минимум задан по ОБЕИМ сторонам', () => {
    /* Слоты снаряжения были 43 пикселя в ширину при 48 в высоту:
       `min-height` про ширину не говорит ничего, а промахиваются
       по узкой стороне. Поймано живым замером, а не этим файлом. */
    for (const square of ['.inv__cell', '.inv__slot']) {
      const bodies = blocksWith(square).join('\n');
      expect(bodies, `${square} без минимума по ширине`).toContain('min-width: var(--tap)');
    }
  });

  it('`.button--small` объявлен ровно один раз', () => {
    /* Два определения с разными отступами уже были, и побеждало
       нижнее: правило выглядело действующим и не действовало. */
    expect(soleBlocks('.button--small')).toHaveLength(1);
  });
});

describe('кликабельное отличимо от статичного', () => {
  it('нажатие даёт отклик, и переход короче 100 мс', () => {
    /* Если после нажатия ничего не произошло за 0.1 с, человек
       перестаёт верить, что элемент кликабелен, и уходит пробовать
       другое. Ожидание ответа сервера этого не оправдывает. */
    expect(css).toMatch(/button:active:not\(\[disabled\]\)/);

    /* Смотрится ПЕРЕХОД САМОЙ КНОПКИ, а не все длительности файла:
       среди них есть подъём цифр урона на 900 мс, и он к отклику
       отношения не имеет. Первая редакция теста этого не различала
       и падала на анимации показа. */
    const button = soleBlocks('.button')[0] ?? '';
    const transition = /transition:([^;]*);/.exec(button)?.[1] ?? '';
    const durations = [...transition.matchAll(/(\d+)ms/g)].map((m) => Number(m[1]));
    expect(durations.length, 'у кнопки нет перехода вовсе').toBeGreaterThan(0);
    for (const ms of durations) expect(ms).toBeLessThan(100);
  });

  it('отключённое приглушено и не отзывается на нажатие', () => {
    const disabled = blocksWith('button[disabled]');
    expect(disabled.length, 'нет правила для отключённых кнопок').toBeGreaterThan(0);
    const body = disabled.join('\n');
    expect(body).toContain('opacity');
    expect(body).toContain('cursor: default');
  });
});

describe('главное действие в нижней трети', () => {
  it('полоса действий липнет к низу экрана', () => {
    const bar = soleBlocks('.screen__actions');
    expect(bar, 'полоса действий объявлена не один раз').toHaveLength(1);
    expect(bar[0]).toContain('position: sticky');
    expect(bar[0]).toMatch(/bottom:\s*0/);
    // Фон непрозрачный: содержимое уезжает ПОД полосу, а не сквозь неё.
    expect(bar[0]).toContain('background');
  });

  it('деревня и рейд пользуются ею, а не своей копией', () => {
    expect(ts('village')).toContain('screen__actions');
    expect(ts('raid')).toContain('screen__actions');
  });

  it('в деревне вход в рейд стоит ПОСЛЕДНИМ', () => {
    /* Прежде кнопка была в середине, а ниже дописали первый урок мира
       и заглушку — главное действие уехало из зоны большого пальца
       текстом, а не правкой лейаута. Проверяется порядок, потому что
       ломается именно он. */
    const src = ts('village');
    const nav = src.indexOf('village__nav screen__actions');
    expect(nav).toBeGreaterThan(0);
    for (const below of ['village__first-blade', 'village__stub', 'village__build']) {
      expect(src.indexOf(below), `${below} оказался ниже кнопки`).toBeLessThan(nav);
    }
  });
});
