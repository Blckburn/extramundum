#!/usr/bin/env node
/**
 * Бюджеты производительности рендера. GDD §3.4.
 *
 * Печатает ЧИСЛА, а не «прошло». Число можно сравнить с прошлой неделей
 * и увидеть, что сцена потяжелела на треть; «прошло» такого не даёт.
 *
 * Выходит с кодом 1, если бюджет нарушен. Бюджет без автоматической
 * проверки — это комментарий, а не бюджет.
 *
 *   node scripts/render-budget.mjs          # цифры + вердикт
 *   node scripts/render-budget.mjs --json   # машиночитаемо
 *
 * ЧЕГО ЭТОТ СКРИПТ НЕ МЕРЯЕТ, и это важнее того, что меряет:
 *
 *  - FPS на мобильном mid-range. Здесь нет ни телефона, ни его GPU,
 *    ни его теплового троттлинга. Кадр, снятый на десктопе в headless
 *    Chromium, не имеет к этой цели отношения, и выдавать его за неё
 *    значило бы поставить зелёную галочку под непроверенным.
 *  - Время до первого кадра на 4G. Нет сетевого профиля; есть только
 *    размер критического пути, и он назван размером, а не временем.
 *
 * Обе величины вынесены в «незакрытое» в CLAUDE.md.
 */
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const DIST = fileURLToPath(new URL('apps/web/dist', root));
const AS_JSON = process.argv.includes('--json');

/* ────────────────────── сцена: материалы и вызовы ────────────────────── */

const { createBattleScene } = await import(
  fileURLToPath(new URL('apps/web/dist-render/scene.js', root))
).catch(() => ({ createBattleScene: null }));

if (createBattleScene === null) {
  console.error(
    'Нет сборки рендера для замера. Сначала: pnpm --filter @extramundum/web build:render',
  );
  process.exit(2);
}

const { measureScene } = await import(
  fileURLToPath(new URL('apps/web/dist-render/budget.js', root))
);
const { RENDER_BUDGETS } = await import(
  fileURLToPath(new URL('packages/shared/dist/render.js', root))
);

const built = createBattleScene(16 / 9);
const scene = measureScene(built.scene);

/* ──────────────────────── аллокации за кадр ──────────────────────────── */

/**
 * Считаем не байты, а РОСТ кучи между двумя одинаковыми сериями кадров.
 *
 * Точного счётчика аллокаций в Node нет, но есть свойство, которое нам
 * и нужно: цикл без аллокаций не двигает `heapUsed` вовсе, а цикл
 * с аллокацией двигает его пропорционально числу кадров. Поэтому
 * гоняем две серии разной длины и смотрим на разницу наклона.
 */
function measureAllocations(loop, frames) {
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < frames; i++) loop.update(1 / 60);
  const after = process.memoryUsage().heapUsed;
  return Math.max(0, after - before);
}

const warmup = 20_000;
built.loop.update(0);
measureAllocations(built.loop, warmup); // прогрев: JIT и первые страницы кучи

const short = measureAllocations(built.loop, 50_000);
const long = measureAllocations(built.loop, 200_000);
// Байт на кадр по наклону: (long − short) / (200k − 50k).
const bytesPerFrame = Math.max(0, (long - short) / 150_000);

/* ───────────────────────────── бандл ─────────────────────────────────── */

function bundleSizes() {
  let assets;
  try {
    assets = readdirSync(`${DIST}/assets`);
  } catch {
    return null;
  }

  let appRaw = 0;
  let appGzip = 0;
  let threeRaw = 0;
  let threeGzip = 0;
  let cssGzip = 0;

  for (const name of assets) {
    if (name.endsWith('.map')) continue;
    const bytes = readFileSync(`${DIST}/assets/${name}`);
    const gz = gzipSync(bytes).length;

    if (name.endsWith('.css')) {
      cssGzip += gz;
    } else if (name.startsWith('three-')) {
      threeRaw += bytes.length;
      threeGzip += gz;
    } else {
      appRaw += bytes.length;
      appGzip += gz;
    }
  }

  return { appRaw, appGzip, threeRaw, threeGzip, cssGzip };
}

const bundle = bundleSizes();

/* ────────────────────────────── вывод ────────────────────────────────── */

const violations = [];
if (scene.meshes > RENDER_BUDGETS.drawCalls) {
  violations.push(['draw calls', scene.meshes, RENDER_BUDGETS.drawCalls]);
}
if (bundle !== null && bundle.appGzip + bundle.cssGzip > RENDER_BUDGETS.bundleGzipBytes) {
  violations.push([
    'бандл gzip без three.js',
    bundle.appGzip + bundle.cssGzip,
    RENDER_BUDGETS.bundleGzipBytes,
  ]);
}
if (bytesPerFrame > 1) {
  violations.push(['байт на кадр', Math.round(bytesPerFrame), 0]);
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} КБ`;

if (AS_JSON) {
  console.log(JSON.stringify({ scene, bundle, bytesPerFrame, violations }, null, 2));
} else {
  console.log('\nБЮДЖЕТЫ РЕНДЕРА · GDD §3.4\n');
  const row = (name, value, limit) =>
    console.log(`  ${String(name).padEnd(30)}${String(value).padStart(12)}   ${limit}`);

  row('материалов в сцене', scene.materials, 'по одному на цвет, кэш');
  row('геометрий', scene.geometries, 'по одной на размер коробки');
  row('видимых мешей = draw calls', scene.meshes, `< ${RENDER_BUDGETS.drawCalls}`);
  row('треугольников', Math.round(scene.triangles), 'прокси нагрузки');
  row('источников света', scene.lights, 'каждый удорожает шейдер');
  row('байт на кадр', bytesPerFrame.toFixed(2), '0 — пул не нужен, пока так');

  if (bundle !== null) {
    console.log('');
    row(
      'бандл приложения, gzip',
      kb(bundle.appGzip + bundle.cssGzip),
      `< ${kb(RENDER_BUDGETS.bundleGzipBytes)}`,
    );
    row('three.js, gzip', kb(bundle.threeGzip), 'отдельным чанком, вне бюджета');
    // Критический путь — то, что браузер качает до первого кадра
    // ПОСЕЛЕНИЯ. Чанк рендера сюда не входит: он приходит динамическим
    // импортом при входе на арену. Это РАЗМЕР, а не время: времени
    // на 4G отсюда не следует, и называть его временем было бы подлогом.
    row('критический путь, gzip', kb(bundle.appGzip + bundle.cssGzip), 'РАЗМЕР, не время');
  }

  console.log('\n  Допущение: меши = draw calls верно ТОЛЬКО без инстансинга.');
  console.log('  Появится InstancedMesh или Points — счётчик начнёт врать');
  console.log('  в безопасную сторону, и считать надо будет renderer.info.');

  console.log('\n  НЕ ИЗМЕРЕНО И НЕ ЗАЯВЛЕНО СОБЛЮДЁННЫМ:');
  console.log('   · FPS на мобильном mid-range — нет телефона, нет его GPU');
  console.log('   · время первого кадра на 4G — нет сетевого профиля');
  console.log('  Обе цели остаются открытыми, см. CLAUDE.md.\n');

  if (violations.length > 0) {
    console.log('БЮДЖЕТ НАРУШЕН:');
    for (const [name, actual, limit] of violations) {
      console.log(`  ${name}: ${actual} при пределе ${limit}`);
    }
    console.log('');
  } else {
    console.log('  Все измеримые бюджеты соблюдены.\n');
  }
}

built.dispose();
process.exit(violations.length > 0 ? 1 : 0);
