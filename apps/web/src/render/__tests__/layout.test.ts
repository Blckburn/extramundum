import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Мобильный лейаут. GDD §10 и §13, пункт 31.
 *
 * «Интерфейс использовал position: fixed с пиксельными координатами
 * и на телефоне налезал сам на себя.» Проверяется то, что можно
 * проверить без браузера: сама форма правил. Живая проверка на 380 px —
 * `pnpm render:probe`, она меряет переполнение и перекрытие в настоящем
 * Chromium, но браузера в CI нет, и делать вид, что есть, хуже,
 * чем честно разделить.
 */

const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');

/** Правила без комментариев: комментарий про position: fixed — не position: fixed. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, ' ');

describe('лейаут проектируется от 380 px вверх', () => {
  it('ни одного position: fixed', () => {
    // Именно этим v1.0 налезал сам на себя: элемент, вырванный из потока
    // и привязанный к окну, не знает, что рядом кто-то есть.
    expect(rules).not.toMatch(/position:\s*fixed/);
  });

  it('единственный position: absolute — холст, и он привязан к родителю', () => {
    const absolutes = [...rules.matchAll(/position:\s*absolute/g)];
    expect(absolutes).toHaveLength(1);

    // inset: 0 относительно родителя, а не координаты относительно окна.
    const start = rules.indexOf('.arena__canvas');
    const canvasRule = rules.slice(start, rules.indexOf('}', start));
    expect(canvasRule).toMatch(/inset:\s*0/);
    expect(canvasRule, 'пиксельные координаты — это ровно v1.0').not.toMatch(
      /\b(top|left|right|bottom):\s*-?\d+px/,
    );
  });

  it('высота экрана боя задана в dvh, а не в vh', () => {
    // На мобильных браузерах панель адреса съезжает: vh оставляет под ней
    // полосу либо режет низ экрана вместе с кнопкой.
    const arena = rules.slice(rules.indexOf('.screen--arena'), rules.indexOf('.arena__stage'));
    expect(arena).toMatch(/height:\s*100dvh/);
    expect(arena).not.toMatch(/height:\s*100vh/);
  });

  it('панель боя учитывает безопасную зону снизу', () => {
    // Иначе на телефоне с жестовой полосой кнопка «Назад» оказывается
    // под ней и не нажимается.
    expect(rules).toMatch(/env\(safe-area-inset-bottom\)/);
  });

  it('нижняя граница проектирования — 380 px, и медиазапросы не ниже неё', () => {
    // Правило, которое включается только на 320 px, означает, что базовый
    // случай спроектирован не от узкого экрана, а от широкого.
    const widths = [...rules.matchAll(/min-width:\s*(\d+)px/g)].map((m) => Number(m[1]));
    for (const width of widths) {
      expect(width, `медиазапрос на ${width}px ниже нижней границы`).toBeGreaterThanOrEqual(380);
    }
  });

  it('размеры в rem и долях, а не в пикселях, кроме границ и радиусов', () => {
    // Пиксель уместен там, где он не должен масштабироваться: линия
    // в один пиксель и радиус скругления. Всё остальное обязано
    // тянуться вместе с размером шрифта.
    const suspicious = [...rules.matchAll(/(padding|margin|gap|width|height):\s*[^;]*?(\d{2,})px/g)]
      .map((m) => m[0].trim())
      .filter((rule) => !rule.includes('min-width') && !rule.includes('max-width'));
    expect(suspicious, 'размер в пикселях там, где нужен rem').toEqual([]);
  });
});
