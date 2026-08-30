import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Проверка формы кривой зон — по исходнику матрицы.
 *
 * Саму кривую тестом не померить: это тысячи боёв, место им в скрипте.
 * Но у проверки есть свойства, которые ОДНАЖДЫ УЖЕ ОТКАЗАЛИ молча,
 * и вот они пиной здесь.
 *
 * Что именно отказало: цель была выражена абсолютным винрейтом
 * и проверялась на ОДНОМ сиде роллов снаряжения. Прогон был зелёным,
 * кривая «стояла на цели» — а по медиане девяти сидов кривой не было
 * вовсе: первые три зоны 74.7 / 76.9 / 74.8, то есть вторая легче
 * первой. Вернуть один сид по умолчанию значит вернуть ту зелёную ложь.
 */
const source = readFileSync(
  fileURLToPath(new URL('../winrate-matrix.mjs', import.meta.url)),
  'utf8',
);

describe('кривая зон проверяется по форме и по медиане', () => {
  it('сидов по умолчанию больше одного', () => {
    const match = /const SEEDS = Math\.max\(1, Number\(flag\('seeds', (\d+)\)\)\)/.exec(source);
    expect(match, 'объявление SEEDS не найдено — проверка ниже ничего не значит').not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThan(1);
  });

  it('число сидов НЕЧЁТНОЕ — иначе медиана усредняет соседей', () => {
    const match = /const SEEDS = Math\.max\(1, Number\(flag\('seeds', (\d+)\)\)\)/.exec(source);
    expect(Number(match?.[1]) % 2).toBe(1);
  });

  it('проверяется ШАГ между зонами, а не абсолютная высота', () => {
    expect(source).toMatch(/const ZONE_STEP = /);
    expect(source).toMatch(/const ZONE_STEP_TOLERANCE = /);
    expect(source).toMatch(/prev\.medianRate - z\.medianRate/);
  });

  it('нарушение формы валит прогон', () => {
    /* Проверка, которая печатает число и не роняет сборку, — это
       комментарий, а не проверка. Ровно так пункт 4 §4.6 простоял
       «не проверяется» до M3b. */
    const exit = /process\.exit\(\s*([^)]*?)\s*\?\s*1\s*:\s*0,?\s*\)/s.exec(source);
    expect(exit, 'вызов process.exit не найден').not.toBeNull();
    expect(exit?.[1]).toContain('stepBreaches.length > 0');
  });

  it('убывание проверяется ОТДЕЛЬНО от допуска', () => {
    /* Шаг −2 п.п. при допуске ±5 формально «в пределах», а означает
       перевёрнутую прогрессию: четвёртая зона легче третьей. Допуском
       это не покрывается ни при каком его размере. */
    expect(source).toMatch(/descends: step > 0/);
    expect(source).toMatch(/!s\.within \|\| !s\.descends/);
  });

  it('подбор ищет МЕДИАНУ, а не попадание одного сида', () => {
    /* Прежний подбор двигал множитель, пока на сиде 0 не выйдет цель, —
       отчего сид 0 и оказался с краю распределения во всех зонах разом. */
    const block = source.slice(source.indexOf('if (CALIBRATE)'));
    const body = block.slice(0, block.indexOf('suggested = Math.round'));
    expect(body).toMatch(/median\(probes\)/);
    expect(body).toMatch(/for \(let sd = 0; sd < SEEDS; sd\+\+\)/);
  });

  it('абсолютный ориентир не убран совсем', () => {
    /* Форма выполняется и на кривой 40/30/20/10/0, где играть
       невозможно нигде. Якорь грубый, но он обязан быть. */
    expect(source).toMatch(/const ZONE_TARGETS = /);
    expect(source).toMatch(/const ZONE_ANCHOR_TOLERANCE = /);
    expect(source).toMatch(/Math\.abs\(medianRate - target\) <= ZONE_ANCHOR_TOLERANCE/);
  });
});
