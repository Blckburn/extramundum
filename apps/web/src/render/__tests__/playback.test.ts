import { animations } from '@extramundum/data';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { measureScene } from '../budget.js';
import { FighterFx } from '../fx.js';
import { ParticleField } from '../particles.js';
import { Pool } from '../pool.js';
import { createBattleScene } from '../scene.js';

/**
 * Воспроизведение боя не ломает бюджеты M2a. GDD §3.4, §13 пункты 19–21.
 *
 * Замер покоя доказывает только то, что покой дёшев. Здесь всё меряется
 * ВО ВРЕМЯ БОЯ: искры в воздухе, вспышки и выпады на обоих бойцах.
 */

const code = (file: string): string =>
  readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Сцена вместе с боевыми эффектами и способом крутить кадры. */
function battleScene() {
  const built = createBattleScene();
  const particles = new ParticleField();
  built.scene.add(particles.mesh);

  const stage = animations.stage;
  const fx: readonly [FighterFx, FighterFx] = [
    new FighterFx(built.fighters[0], stage, 1),
    new FighterFx(built.fighters[1], stage, -1),
  ];

  const point = built.camera.position.clone();
  let clock = 0;
  let sinceEvent = 0;
  let side = 0;
  let bursts = 0;

  const frame = (dt: number): void => {
    clock += dt * 1000;
    sinceEvent += dt * 1000;

    if (sinceEvent >= 300) {
      sinceEvent = 0;
      side = side === 0 ? 1 : 0;
      const target = side === 0 ? 1 : 0;
      fx[side]?.startLunge(clock, 280, 0.55);
      fx[target]?.startShake(clock, 260, 0.16);
      fx[target]?.startFlash(clock, 160, 2.4, 'blood');
      particles.burst(fx[target]?.burstPoint(point) ?? point, 'blood', 14, 520);
      bursts++;
    }

    built.loop.update(dt);
    particles.update(dt);
    fx[0].update(clock);
    fx[1].update(clock);
  };

  return {
    built,
    particles,
    fx,
    frame,
    get bursts() {
      return bursts;
    },
    get clock() {
      return clock;
    },
    dispose() {
      particles.dispose();
      built.dispose();
    },
  };
}

describe('бюджеты во время боя', () => {
  it('партиклы стоят ОДИН вызов отрисовки на сотни искр', () => {
    const scene = battleScene();
    const before = measureScene(scene.built.scene);
    for (let i = 0; i < 120; i++) scene.frame(1 / 60);
    const during = measureScene(scene.built.scene);

    // Искры действительно в воздухе — иначе замер сделан на пустой сцене
    // и не значит ничего.
    expect(scene.particles.activeCount).toBeGreaterThan(10);

    expect(during.meshes).toBe(before.meshes);
    expect(during.instancedMeshes).toBe(1);
    expect(during.instances).toBeGreaterThan(100);
    // Двести двадцать искр не добавили ни одного вызова сверх одного меша.
    expect(during.meshes - (before.meshes - 1)).toBe(1);

    scene.dispose();
  });

  it('в теле update партиклов и эффектов нет ничего, что выделяет память', () => {
    for (const file of ['particles.ts', 'fx.ts']) {
      const source = code(file);
      const start = source.indexOf('update(');
      expect(start, `${file}: не нашли update — тест смотрит не туда`).toBeGreaterThan(0);
      const body = source.slice(start);

      expect(body, `${file}: new в кадре — это аллокация`).not.toMatch(/\bnew\s+[A-Z]/);
      expect(body, `${file}: for...of создаёт итератор на каждый кадр`).not.toMatch(
        /for\s*\(\s*const\s+\w+\s+of\b/,
      );
      expect(body, `${file}: методы-итераторы аллоцируют`).not.toMatch(
        /\.(map|filter|forEach|reduce|slice|concat)\(/,
      );
    }
  });

  it('за кадр боя не появляется ни одной аллокации — где это меряется', () => {
    /**
     * ЧИСЛО БАЙТ НА КАДР ЗДЕСЬ НЕ МЕРЯЕТСЯ, и это решение, а не пропуск.
     *
     * `process.memoryUsage().heapUsed` — величина на ВЕСЬ процесс,
     * а vitest гоняет файлы параллельными воркерами в одном процессе.
     * Замеренная разница оказывается чужим мусором: тот же цикл в полном
     * прогоне репозитория давал то 0, то 54 байта на кадр, без единой
     * правки кода. Тест, красный через раз, хуже отсутствующего —
     * его начинают перезапускать вместо того, чтобы читать.
     *
     * Число меряется в scripts/render-budget.mjs: отдельный процесс,
     * никого рядом, наклон между двумя сериями разной длины. Этот шаг
     * есть в CI и падает при нарушении — там же поймано 18 байт на кадр
     * от разбора строки цвета.
     *
     * Здесь остаётся то, что проверяется НАДЁЖНО: форма кода.
     */
    const scene = battleScene();
    for (let i = 0; i < 600; i++) scene.frame(1 / 60);

    // Цикл действительно работал: искры в воздухе, всплески случались.
    expect(scene.bursts).toBeGreaterThan(20);
    expect(scene.particles.activeCount).toBeGreaterThan(0);

    // Пул не вырос: рост в кадре и есть аллокация.
    expect(scene.particles.activeCount).toBeLessThanOrEqual(220);

    scene.dispose();
  });

  it('разбор цвета вынесен из кадра: Color.set(строка) в бою запрещён', () => {
    // Замер поймал это как 18 байт на кадр при заявленном нуле:
    // `Color.set('#rrggbb')` разбирает строку регулярным выражением
    // и создаёт массив совпадений на каждый всплеск.
    for (const file of ['particles.ts', 'fx.ts']) {
      expect(code(file), `${file}: разбор строки цвета аллоцирует`).not.toMatch(
        /color\.set\(|\.color\.set\(/,
      );
    }
  });
});

describe('пул объектов', () => {
  it('не растёт и не создаёт ничего после сборки', () => {
    let created = 0;
    const pool = new Pool<{ id: number }>(4, (index) => {
      created++;
      return { id: index };
    });

    expect(created).toBe(4);
    for (let i = 0; i < 50; i++) pool.acquire();
    expect(created, 'пул вырос в рантайме — это аллокация в кадре').toBe(4);
    expect(pool.all).toHaveLength(4);
  });

  it('при переполнении забирает САМЫЙ СТАРЫЙ занятый', () => {
    const pool = new Pool<{ id: number }>(3, (index) => ({ id: index }));
    const first = pool.acquire();
    pool.acquire();
    pool.acquire();
    expect(pool.activeCount).toBe(3);

    // Четвёртый обязан вытеснить первый: терять одну искру из трёх
    // лучше, чем аллоцировать в кадре.
    const fourth = pool.acquire();
    expect(fourth).toBe(first);
    expect(pool.activeCount).toBe(3);
  });

  it('освобождение возвращает слот в оборот', () => {
    const pool = new Pool<{ id: number }>(2, (index) => ({ id: index }));
    const slot = pool.acquire();
    expect(pool.activeCount).toBe(1);
    pool.release(slot);
    expect(pool.activeCount).toBe(0);
    pool.releaseAll();
    expect(pool.activeCount).toBe(0);
  });
});

describe('перемотка не оставляет следов будущего', () => {
  it('очистка гасит все искры', () => {
    const scene = battleScene();
    for (let i = 0; i < 120; i++) scene.frame(1 / 60);
    expect(scene.particles.activeCount).toBeGreaterThan(0);

    scene.particles.clear();
    expect(scene.particles.activeCount).toBe(0);

    scene.dispose();
  });

  it('сброс эффектов возвращает бойца на место', () => {
    const scene = battleScene();
    const rig = scene.built.fighters[0];
    const baseX = rig.root.position.x;

    scene.fx[0].startLunge(0, 280, 0.55);
    scene.fx[0].update(140);
    // Выпад обязан СДВИНУТЬ бойца — иначе «вернулся на место»
    // выполняется и при неработающем выпаде.
    expect(Math.abs(rig.root.position.x - baseX)).toBeGreaterThan(0.3);

    scene.fx[0].reset();
    scene.fx[0].update(140);
    expect(rig.root.position.x).toBe(baseX);

    scene.dispose();
  });

  it('упавший остаётся лежать, но перемотка его поднимает', () => {
    // Падение — единственный эффект, который НЕ возвращается к покою:
    // обычная развёртка гасит его после конца, и убитый вставал бы.
    // А перемотка назад обязана его отменять: в середине боя он жив.
    const scene = battleScene();
    const rig = scene.built.fighters[0];
    expect(rig.root.rotation.z).toBe(0);

    scene.fx[0].startTopple(1000, 700, 1.5);
    scene.fx[0].update(1350);
    const midway = rig.root.rotation.z;
    expect(Math.abs(midway)).toBeGreaterThan(0.5);

    // Далеко ПОСЛЕ конца: остаётся лежать, а не поднимается.
    scene.fx[0].update(9000);
    expect(Math.abs(rig.root.rotation.z)).toBeGreaterThan(Math.abs(midway));
    expect(Math.abs(rig.root.rotation.z)).toBeCloseTo(1.5, 5);

    // Момент ДО падения: боец стоит.
    scene.fx[0].update(900);
    expect(rig.root.rotation.z).toBe(0);

    scene.dispose();
  });

  it('часы, ушедшие назад, гасят эффект', () => {
    const scene = battleScene();
    const rig = scene.built.fighters[1];
    const baseX = rig.root.position.x;

    scene.fx[1].startLunge(1000, 280, 0.55);
    scene.fx[1].update(1140);
    expect(Math.abs(rig.root.position.x - baseX)).toBeGreaterThan(0.3);

    // Момент ДО начала выпада: эффект ещё не случился.
    scene.fx[1].update(900);
    expect(rig.root.position.x).toBe(baseX);

    scene.dispose();
  });

  it('вспышка гаснет сама и не трогает общий материал', () => {
    const scene = battleScene();
    for (let i = 0; i < 60; i++) scene.frame(1 / 60);

    // Материал общий на всю сцену: покрасить его ради одного бойца
    // значило бы перекрасить всех разом. Вспышка обязана быть СВЕТОМ.
    expect(code('fx.ts')).not.toMatch(/\.material\b/);

    scene.dispose();
  });
});

describe('всплывающие числа не работают в кадре', () => {
  it('проекция считается при рождении числа, а не каждый кадр', () => {
    // Камера за бой не двигается, поэтому мировая точка проецируется
    // один раз. Появление project() в периодическом методе означало бы
    // возврат к работе в кадре — и к строке в style на каждое число.
    const source = code('numbers.ts');
    const spawn = source.slice(source.indexOf('spawn('), source.indexOf('collect('));
    const rest = source.slice(source.indexOf('collect('));

    expect(spawn).toMatch(/\.project\(/);
    expect(rest, 'проекция в периодическом методе — это работа в кадре').not.toMatch(/\.project\(/);
  });

  it('подъём и затухание — CSS, а не запись стиля из JS', () => {
    const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
    expect(styles).toMatch(/@keyframes number-rise/);
    // Пауза обязана останавливать и цифры: иначе на паузе они
    // продолжают всплывать, и пауза выглядит сломанной.
    expect(styles).toMatch(/\.numbers--paused[\s\S]*?animation-play-state:\s*paused/);
  });
});
