import { RENDER_BUDGETS } from '@extramundum/shared';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DRAW_CALLS_UPPER_BOUND_HOLDS, measureScene } from '../budget.js';
import { createBattleScene } from '../scene.js';

/**
 * Бюджеты производительности. GDD §3.4.
 *
 * Бюджет без автоматической проверки — это комментарий, а не бюджет.
 */

const source = (file: string): string =>
  readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

/**
 * Исходник без комментариев.
 *
 * Проверять надо КОД, а не текст рядом с ним: в frame.ts слово traverse
 * стоит в объяснении, почему обхода нет. Тест, спотыкающийся о собственный
 * комментарий, заставляет убрать объяснение — то есть наказывает ровно
 * за то, что делает код понятным.
 */
const code = (file: string): string =>
  source(file)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('бюджеты сцены', () => {
  it('вызовов отрисовки меньше 120', () => {
    const built = createBattleScene();
    const budget = measureScene(built.scene);

    expect(budget.meshes).toBeLessThan(RENDER_BUDGETS.drawCalls);
    // И сцена НЕ пуста: бюджет, соблюдённый пустой сценой, ничего
    // не доказывает. Два бойца по два десятка коробок плюс арена.
    expect(budget.meshes).toBeGreaterThan(40);

    built.dispose();
  });

  it('ГРАНИЦА: посчитанные меши ограничивают вызовы отрисовки сверху', () => {
    // Тест существует ради предупреждения в том месте, где его нельзя
    // пропустить. `meshes` — верхняя граница, а не равенство: живой
    // замер даёт 72 при 75 посчитанных, потому что три меша отсекаются
    // по пирамиде видимости. Отсечение всегда в безопасную сторону.
    //
    // Граница ломается в ОПАСНУЮ сторону от двух вещей: массива
    // материалов на меше (один объект — несколько вызовов) и лишнего
    // прохода рисования (тени, постобработка). Оба ищем в исходниках.
    expect(DRAW_CALLS_UPPER_BOUND_HOLDS).toBe(true);

    const rig = code('rig.ts');
    expect(rig, 'массив материалов на меше ломает верхнюю границу').not.toMatch(
      /new Mesh\([^)]*\[/,
    );

    const index = code('index.ts');
    expect(index, 'тени — это ещё один проход по сцене').not.toMatch(/shadowMap|castShadow/);
    expect(index, 'постобработка — это ещё один проход по сцене').not.toMatch(
      /EffectComposer|RenderPass/,
    );
  });

  it('материалов ровно столько, сколько различных цветов', () => {
    const built = createBattleScene();
    const budget = measureScene(built.scene);

    expect(budget.materials).toBe(built.materials.size);
    expect(budget.materials).toBeLessThan(20);

    built.dispose();
  });

  it('источников света мало: каждый удорожает шейдер на мобильном', () => {
    const built = createBattleScene();
    expect(measureScene(built.scene).lights).toBeLessThanOrEqual(6);
    built.dispose();
  });
});

describe('кадр не аллоцирует', () => {
  /**
   * Две проверки, потому что одной мало.
   *
   * Первая — по ИСХОДНИКУ: в теле `update` не должно быть ни `new`,
   * ни литералов объекта и массива, ни `for...of` (он создаёт итератор
   * на каждый вызов), ни методов-итераторов вроде `.map`. Проверка
   * не флакающая и указывает пальцем на строку.
   *
   * Вторая — по КУЧЕ: гоняем много кадров и смотрим, растёт ли она.
   * Такая проверка шумная, поэтому порог грубый — она ловит не байты,
   * а появление аллокации как класса.
   */
  it('в теле update нет ничего, что выделяет память', () => {
    const frame = code('frame.ts');
    const body = frame.slice(frame.indexOf('update(dt: number): void {'));
    expect(body.length, 'не нашли тело update — тест смотрит не туда').toBeGreaterThan(100);

    expect(body, 'new в кадре — это аллокация').not.toMatch(/\bnew\s+[A-Z]/);
    expect(body, 'for...of по массиву создаёт итератор на каждый кадр').not.toMatch(
      /for\s*\(\s*const\s+\w+\s+of\b/,
    );
    expect(body, 'методы-итераторы аллоцируют').not.toMatch(
      /\.(map|filter|forEach|reduce|slice|concat)\(/,
    );
    expect(body, 'литерал объекта в кадре — аллокация').not.toMatch(/=\s*\{\s*\w+:/);
  });

  it('цикл крутится вхолостую, а байты считает отдельный процесс', () => {
    /**
     * Раньше здесь мерялся рост кучи, и это оказалось ненадёжным.
     *
     * `heapUsed` — величина на ВЕСЬ процесс, а vitest гоняет файлы
     * параллельными воркерами в одном процессе: разница оказывается
     * чужим мусором. Тот же цикл в полном прогоне давал то 0, то 54
     * байта на кадр без единой правки кода. Красный через раз тест
     * начинают перезапускать вместо того, чтобы читать.
     *
     * Число меряется в scripts/render-budget.mjs — отдельный процесс,
     * наклон между двумя сериями разной длины, шаг в CI. Здесь остаётся
     * проверка по исходнику (выше) и то, что цикл вообще работает.
     */
    const built = createBattleScene();
    expect(built.loop.flickerCount, 'мерцать нечему — цикл пуст и тест пуст').toBeGreaterThan(0);

    for (let i = 0; i < 1_000; i++) built.loop.update(1 / 60);

    built.dispose();
  });
});

describe('никаких обходов сцены в кадре', () => {
  it('frame.ts не знает про traverse', () => {
    // GDD §13, пункт 20: в v1.0 полный обход сцены выполнялся каждый кадр
    // на каждого бойца ради вспышки урона, плюс ещё один ради факелов.
    expect(code('frame.ts')).not.toMatch(/\.traverse\(/);
  });

  it('в кадровом цикле index.ts тоже нет обхода', () => {
    const index = code('index.ts');
    const tick = index.slice(index.indexOf('const tick ='), index.indexOf('return {'));
    expect(tick.length).toBeGreaterThan(50);
    expect(tick).not.toMatch(/\.traverse\(/);
  });

  it('обход разрешён только в замере, и он не в кадре', () => {
    // Единственное законное место: measureScene, вызываемая один раз.
    expect(code('budget.ts')).toMatch(/\.traverse\(/);
  });
});
