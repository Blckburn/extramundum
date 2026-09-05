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
    const block = source.slice(source.indexOf('const ladderSuggested'));
    const body = block.slice(0, block.indexOf('power: Math.round'));
    expect(body).toMatch(/median\(probes\)/);
    expect(body).toMatch(/for \(let sd = 0; sd < SEEDS; sd\+\+\)/);
  });

  it('ПОДБОР ИДЁТ ПО УЧАСТКАМ, а не по зонам', () => {
    /* Одно число на четыре ступени не выражает того, что внутри зоны
       трудность идёт не туда: замер лестницы показал падение на 44 п.п.
       в Пустошах и РОСТ в Катакомбах и Кузне. */
    expect(source).toMatch(/const ladderSuggested\s*=/);
    expect(source).toMatch(/function ladderTarget\(/);
    // Второго подбора рядом быть не должно: он считал бы то же самое.
    expect(source).not.toMatch(/suggested = Math\.round/);
  });

  it('абсолютный ориентир не убран совсем', () => {
    /* Форма выполняется и на кривой 40/30/20/10/0, где играть
       невозможно нигде. Якорь грубый, но он обязан быть. */
    expect(source).toMatch(/const ZONE_TARGETS = /);
    expect(source).toMatch(/const ZONE_ANCHOR_TOLERANCE = /);
    expect(source).toMatch(/Math\.abs\(medianRate - target\) <= ZONE_ANCHOR_TOLERANCE/);
  });
});

/**
 * ЛЕСТНИЦА УЧАСТКОВ И ПРОВЕРКА НА ТУПИК.
 *
 * Обе появились вместе с участками (PLAYTEST 2026-09-04). Кривая зон
 * меряет одну точку на зону — четвёртый участок; внутри зоны теперь
 * четыре ступени, и мерить только верх значило бы не видеть три
 * из четырёх.
 *
 * Проверяется по исходнику по той же причине, что и кривая: сам замер
 * — это тысячи боёв, место им в скрипте. Здесь стоят свойства, потеря
 * которых сделала бы прогон зелёным на сломанной игре.
 */
describe('лестница участков и тупик', () => {
  it('лестница меряется по ВСЕМ участкам, а не по одному на зону', () => {
    expect(source).toMatch(/const ladder = zones\.flatMap/);
    expect(source).toMatch(/zone\.segments\.map\(\(spec, segment\)/);
  });

  it('ступень ВВЕРХ валит прогон', () => {
    /* Участок легче предыдущего — перевёрнутая прогрессия. Проверка,
       которая это печатает и не роняет сборку, — комментарий,
       а не проверка. */
    expect(source).toMatch(/const ladderBreaches = ladderSteps\.filter/);
    expect(source).toMatch(/ladderBreaches\.length > 0 \|\|/);
  });

  it('цель 10 п.п. к ступеням участков НЕ применяется', () => {
    /* Между участками ожидаемый шаг ~2.5 п.п., то есть ниже шума
       медианы 25 сидов. Проверять цель на такой величине значило бы
       проверять шум и валить прогон за разброс. */
    expect(source).toMatch(/const LADDER_RISE_TOLERANCE\s*=/);
    expect(source).not.toMatch(/ladderStep[^s].*ZONE_STEP/);
  });

  it('ТУПИК ПРОВЕРЯЕТСЯ, и его возврат валит прогон', () => {
    /* Главное свойство правки: пройденный участок остаётся проходимым
       навсегда, то есть винрейт на нём не падает с ростом уровня
       игрока. */
    expect(source).toMatch(/const DEADLOCK_LEVELS\s*=/);
    expect(source).toMatch(/const deadlockBreaches\s*=/);
    expect(source).toMatch(/deadlockBreaches\.length > 0 \|\|/);
  });

  it('у проверки на тупик есть ПАРА: уровень игрока обязан что-то менять', () => {
    /* «Винрейт не падает» верно и для замера, где уровень игрока
       не меняет вообще ничего, — а это ровно та поломка, которую
       проверка обязана ловить. Рост обязан быть виден. */
    expect(source).toMatch(/const deadlockFlat\s*=/);
    expect(source).toMatch(/deadlockFlat \|\|/);
  });

  it('УРОВЕНЬ ИГРОКА НЕ ВХОДИТ в расчёт уровня врага', () => {
    /* Тупик был свойством формулы `clamp(уровень игрока + сдвиг, мин,
       макс)`. Вернуть уровень игрока в этот расчёт — значит вернуть
       тупик, и никакая калибровка чисел от него не спасёт. */
    expect(source).not.toMatch(/player\.level \+ balance\.raid\.difficulty/);
    expect(source).not.toMatch(/enemyLevelOffset/);
  });
});
