import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * ИТОГ БОЯ НЕ ВИДЕН ДО КОНЦА ВОСПРОИЗВЕДЕНИЯ.
 *
 * Проверка по ИСХОДНИКУ, как у «никаких обходов сцены в кадре»: экраны
 * живут в DOM, а тесты здесь идут в окружении node, и поднимать jsdom
 * ради одной проверки значило бы завести зависимость вне зафиксированного
 * стека. Проверяемое свойство при этом структурное, а не поведенческое:
 * панель наград не должна попадать в разметку в момент сборки экрана.
 *
 * Почему это вообще проверяется. На первых живых сессиях бой пропускали
 * ВСЕГДА, и причина оказалась не в зрелищности: панель наград и кнопка
 * «продолжить» выкладывались вместе с ареной, поэтому «Отряд погиб»
 * стояло над боем с первого кадра. Единственная причина смотреть бой
 * уничтожалась одной кнопкой.
 */

const source = (file: string): string =>
  readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

/**
 * Кусок исходника от начала до заданного закрытия.
 *
 * Закрытие задаётся явно, а не угадывается по отступу: у вызова
 * `host.append(` и у объявления функции они разные, и одна общая догадка
 * молча захватила бы половину файла — тогда проверка «в разметке нет
 * кнопки» прошла бы или упала по причине, не имеющей к ней отношения.
 */
function chunk(text: string, start: string, close: string): string {
  const at = text.indexOf(start);
  if (at < 0) throw new Error(`не найдено начало «${start}»`);
  const rest = text.slice(at);
  const end = rest.indexOf(close);
  if (end < 0) throw new Error(`не найдено закрытие «${close}» после «${start}»`);
  return rest.slice(0, end + close.length);
}

describe('итог боя не показывается раньше конца боя', () => {
  const raid = source('raid.ts');
  const show = chunk(raid, 'async function showBattle(', '\n  }\n');

  it('панель наград собирается ТОЛЬКО в reveal', () => {
    const calls = [...show.matchAll(/rewardsBlock\(/g)];
    // Сначала — что проверять есть что: награды всё-таки показываются.
    // Без этого проверка ниже прошла бы и на экране, где их нет вовсе.
    expect(calls.length, 'награды не показываются нигде').toBeGreaterThan(0);

    const revealBody = chunk(show, 'const reveal = ', '\n    };');
    const inReveal = [...revealBody.matchAll(/rewardsBlock\(/g)].length;
    expect(inReveal, 'награды собираются вне reveal').toBe(calls.length);
  });

  it('reveal привязан к концу воспроизведения', () => {
    expect(show).toContain('onFinished: reveal');
  });

  it('первая разметка арены не содержит ни наград, ни кнопки выхода', () => {
    const append = chunk(show, 'host.append(', '\n    );');
    expect(append).not.toContain('rewardsBlock');
    expect(append).not.toContain('done');
  });
});

describe('показ зовёт onFinished только по завершении', () => {
  const mount = readFileSync(new URL('../../battle/mount.ts', import.meta.url), 'utf8');

  it('вызов стоит внутри ветки player.finished', () => {
    const at = mount.indexOf('battle.onFinished?.()');
    expect(at, 'вызова нет вовсе').toBeGreaterThan(0);

    const branch = mount.lastIndexOf('if (player.finished', 0 + at);
    expect(branch, 'вызов вне ветки завершения').toBeGreaterThan(0);
    // Между условием и вызовом не должно быть закрытия ветки.
    expect(mount.slice(branch, at)).not.toContain('\n    }');
  });
});
