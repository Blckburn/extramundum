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

const { ParticleField } = await import(
  fileURLToPath(new URL('apps/web/dist-render/particles.js', root))
);
const { FighterFx } = await import(fileURLToPath(new URL('apps/web/dist-render/fx.js', root)));
const { animations } = await import(fileURLToPath(new URL('packages/data/dist/render.js', root)));

const built = createBattleScene(16 / 9);

/* ─────────────────────── бой, а не статичная сцена ────────────────────

   Замер покоя доказывает только то, что покой дёшев. Поэтому здесь
   собирается ровно то, что работает во время боя: партиклы в сцене,
   эффекты на обоих бойцах и события примерно с той же частотой, с какой
   их порождает движок.

   Цифры урона в этот цикл не входят, и это не упущение: они не делают
   в кадре НИЧЕГО — координата считается один раз при рождении числа,
   подъём и затухание крутит браузер (см. numbers.ts). Их цена меряется
   отдельно, ниже. */

const particles = new ParticleField();
built.scene.add(particles.mesh);

const stage = animations.stage;
const fx = [
  new FighterFx(built.fighters[0], stage, 1),
  new FighterFx(built.fighters[1], stage, -1),
];

/* Вектор берётся клонированием существующего, а не `new Vector3()`.
   three лежит в node_modules клиента, а не в корне, и импортировать его
   отсюда по имени нечем — зато любой объект сцены уже приносит свой. */
const point = built.camera.position.clone();
let clock = 0;
let sinceEvent = 0;
let side = 0;

/** Один кадр боя: сцена, партиклы, эффекты обоих бойцов. */
function battleFrame(dt) {
  clock += dt * 1000;
  sinceEvent += dt * 1000;

  // Событие примерно раз в 300 мс — шаг `damage` из animations.json.
  if (sinceEvent >= 300) {
    sinceEvent = 0;
    side = side === 0 ? 1 : 0;
    const target = side === 0 ? 1 : 0;
    fx[side].startLunge(clock, 280, 0.55);
    fx[target].startShake(clock, 260, 0.16);
    fx[target].startFlash(clock, 160, 2.4, 'blood');
    particles.burst(fx[target].burstPoint(point), 'blood', 14, 520);
  }

  built.loop.update(dt);
  particles.update(dt);
  fx[0].update(clock);
  fx[1].update(clock);
}

// Замер сцены — ПОСЛЕ добавления партиклов и в разгар боя: с искрами
// в воздухе, а не на пустой арене.
for (let i = 0; i < 120; i++) battleFrame(1 / 60);
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
function measureAllocations(step, frames) {
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < frames; i++) step(1 / 60);
  const after = process.memoryUsage().heapUsed;
  return Math.max(0, after - before);
}

const warmup = 20_000;
measureAllocations(battleFrame, warmup); // прогрев: JIT и первые страницы кучи

const short = measureAllocations(battleFrame, 50_000);
const long = measureAllocations(battleFrame, 200_000);
// Байт на кадр по наклону: (long − short) / (200k − 50k).
const bytesPerFrame = Math.max(0, (long - short) / 150_000);

/* ───────────────── проекция координат для цифр урона ─────────────────

   Человек спросил цену проекции прямо: если она упрётся на слабом
   устройстве, вместо DOM останутся спрайты.

   Меряется стоимость ОДНОЙ проекции мировой точки в экранную —
   то есть `Vector3.project(camera)`, ровно тот вызов, что делает
   numbers.ts. За кадр он не делается НИ РАЗУ: камера за бой
   не двигается, поэтому точка считается один раз при рождении числа.
   Значит цена измеряется в цифрах, а не в кадрах, и её надо сравнивать
   с частотой событий боя, а не с 60 Гц. */

function measureProjection(samples) {
  const vector = built.camera.position.clone();
  const source = built.fighters[0].root.position.clone();
  source.y = 1.4;
  built.camera.updateMatrixWorld();

  // Прогрев: первые вызовы идут по интерпретатору.
  for (let i = 0; i < samples; i++) vector.copy(source).project(built.camera);

  const started = process.hrtime.bigint();
  for (let i = 0; i < samples; i++) vector.copy(source).project(built.camera);
  const elapsed = Number(process.hrtime.bigint() - started);
  return elapsed / samples / 1000; // микросекунды на одну проекцию
}

const projectionUs = measureProjection(200_000);

/* ───────────────────────────── бандл ─────────────────────────────────── */

function bundleSizes() {
  let assets;
  try {
    assets = readdirSync(`${DIST}/assets`);
  } catch {
    return null;
  }

  /**
   * Что из этого КРИТИЧЕСКИЙ ПУТЬ, а что подгружается потом.
   *
   * Раньше складывалось всё подряд, и с разделением на чанки в M2b
   * число стало врать: чанки рендера, проигрывателя и эффектов
   * приходят динамическим импортом при входе на арену, а до первого
   * кадра поселения браузер их не качает. Считать их критическим путём
   * значило бы измерять не ту величину — ровно то, за что этот скрипт
   * ругает бюджеты «на глаз».
   *
   * Входной чанк опознаётся по ссылке из index.html, а не по имени:
   * имена с хешем меняются на каждой сборке.
   */
  let entry = '';
  try {
    const html = readFileSync(`${DIST}/index.html`, 'utf8');
    entry = /src="\/assets\/([^"]+\.js)"/.exec(html)?.[1] ?? '';
  } catch {
    entry = '';
  }

  let appRaw = 0;
  let appGzip = 0;
  let asyncGzip = 0;
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
    } else if (entry !== '' && name !== entry) {
      asyncGzip += gz;
    } else {
      appRaw += bytes.length;
      appGzip += gz;
    }
  }

  return { appRaw, appGzip, asyncGzip, threeRaw, threeGzip, cssGzip };
}

const bundle = bundleSizes();

/* ────────────────────────────── вывод ────────────────────────────────── */

const violations = [];
if (scene.meshes > RENDER_BUDGETS.drawCalls) {
  violations.push(['draw calls', scene.meshes, RENDER_BUDGETS.drawCalls]);
}
// Бюджет §3.4 — на ВЕСЬ клиент без three.js, а не только на входной
// чанк: игрок, дошедший до арены, качает и то и другое.
const appTotalGzip = bundle === null ? 0 : bundle.appGzip + bundle.asyncGzip + bundle.cssGzip;
if (bundle !== null && appTotalGzip > RENDER_BUDGETS.bundleGzipBytes) {
  violations.push(['бандл gzip без three.js', appTotalGzip, RENDER_BUDGETS.bundleGzipBytes]);
}
if (bytesPerFrame > 1) {
  violations.push(['байт на кадр', Math.round(bytesPerFrame), 0]);
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} КБ`;

if (AS_JSON) {
  console.log(JSON.stringify({ scene, bundle, bytesPerFrame, projectionUs, violations }, null, 2));
} else {
  console.log('\nБЮДЖЕТЫ РЕНДЕРА · GDD §3.4\n');
  const row = (name, value, limit) =>
    console.log(`  ${String(name).padEnd(30)}${String(value).padStart(12)}   ${limit}`);

  row('материалов в сцене', scene.materials, 'по одному на цвет, кэш');
  row('геометрий', scene.geometries, 'по одной на размер коробки');
  row('видимых мешей = draw calls', scene.meshes, `< ${RENDER_BUDGETS.drawCalls}`);
  row('из них инстансированных', scene.instancedMeshes, 'один вызов на все копии');
  row('копий в инстансах', scene.instances, 'вызовов не добавляют, нагрузку — да');
  row('треугольников', Math.round(scene.triangles), 'прокси нагрузки');
  row('источников света', scene.lights, 'каждый удорожает шейдер');
  row('байт на кадр В БОЮ', bytesPerFrame.toFixed(2), '0 — искры, эффекты, выпады');
  row('проекция точки, мкс', projectionUs.toFixed(3), 'раз на цифру, не раз на кадр');

  if (bundle !== null) {
    console.log('');
    row('бандл приложения, gzip', kb(appTotalGzip), `< ${kb(RENDER_BUDGETS.bundleGzipBytes)}`);
    row('three.js, gzip', kb(bundle.threeGzip), 'отдельным чанком, вне бюджета');
    row('догружается на арене, gzip', kb(bundle.asyncGzip), 'рендер, эффекты, проигрыватель');
    // Критический путь — то, что браузер качает до первого кадра
    // ПОСЕЛЕНИЯ. Чанк рендера сюда не входит: он приходит динамическим
    // импортом при входе на арену. Это РАЗМЕР, а не время: времени
    // на 4G отсюда не следует, и называть его временем было бы подлогом.
    row('критический путь, gzip', kb(bundle.appGzip + bundle.cssGzip), 'РАЗМЕР, не время');
  }

  console.log('\n  Инстансинг в сцене ЕСТЬ: партиклы — один InstancedMesh.');
  console.log('  Верхнюю границу он не ломает (один вызов на все копии),');
  console.log('  но и нагрузку больше не отражает — отсюда строка «копий».');
  console.log('  Живое число вызовов берёт pnpm render:probe из renderer.info.');

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

particles.dispose();
built.dispose();
process.exit(violations.length > 0 ? 1 : 0);
