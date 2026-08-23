#!/usr/bin/env node
/**
 * Живой замер рендера в настоящем Chromium. GDD §3.4.
 *
 * Отличается от `render-budget.mjs` тем, что берёт числа У САМОГО
 * РЕНДЕРА — `renderer.info.render.calls` после кадра, — а не считает
 * меши. Счётчик рендера не зависит от допущения «меши = вызовы»,
 * которое сломается, как только в M2b появится инстансинг.
 *
 * Зависимостей нет намеренно. Chromium уже лежит в образе среды
 * разработки, а Node 22 умеет WebSocket из коробки — значит с браузером
 * можно говорить по CDP напрямую. Добавлять Playwright в devDependencies
 * ради одного замера значило бы тащить в CI скачивание браузера.
 *
 * ЭТО ЛОКАЛЬНЫЙ ИНСТРУМЕНТ. В CI его нет: там нет браузера, и притворяться,
 * что есть, хуже, чем не мерить. Если Chromium не найден — скрипт говорит
 * об этом и выходит с нулём, а не роняет сборку.
 *
 * ЧТО ЭТОТ ЗАМЕР НЕ ЗНАЧИТ: миллисекунды кадра сняты на десктопном GPU
 * (а в этой среде — на программном рендерере SwiftShader). К цели
 * «60 FPS на мобильном mid-range» они отношения не имеют. Это прокси,
 * и назван он прокси.
 *
 *   node scripts/render-probe.mjs --url http://127.0.0.1:5199/probe.html
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? fallback : argv[at + 1];
};

const URL_TO_OPEN = flag('url', 'http://127.0.0.1:5199/probe.html');
const SHOT = flag('shot', '');
const WIDTH = Number(flag('width', 1280));
const HEIGHT = Number(flag('height', 720));

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean);

const binary = CANDIDATES.find((path) => existsSync(path));
if (binary === undefined) {
  console.log('Chromium не найден — живой замер пропущен. Считанные бюджеты: pnpm render:budget');
  process.exit(0);
}

const PORT = 9333;
const chrome = spawn(
  binary,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    // Софтверный GL: в контейнере нет видеокарты, а WebGL нужен настоящий.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function endpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await res.json()).webSocketDebuggerUrl;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('Chromium не поднял отладочный порт');
}

function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', reject);
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  return {
    ready,
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    close: () => socket.close(),
  };
}

try {
  const client = cdp(await endpoint());
  await client.ready;

  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });

  await client.send('Page.enable', {}, sessionId);
  await client.send('Runtime.enable', {}, sessionId);
  await client.send(
    'Emulation.setDeviceMetricsOverride',
    {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: WIDTH < 500,
    },
    sessionId,
  );

  await client.send('Page.navigate', { url: URL_TO_OPEN }, sessionId);

  let probe = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    const result = await client.send(
      'Runtime.evaluate',
      { expression: 'JSON.stringify(window.__probe ?? null)', returnByValue: true },
      sessionId,
    );
    probe = JSON.parse(result.result.value ?? 'null');
    if (probe !== null) break;
  }

  if (probe === null) throw new Error('страница не отдала window.__probe за 20 секунд');

  const renderer = await client.send(
    'Runtime.evaluate',
    {
      expression: `(() => { const gl = document.createElement('canvas').getContext('webgl2');
        const d = gl?.getExtension('WEBGL_debug_renderer_info');
        return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'неизвестен'; })()`,
      returnByValue: true,
    },
    sessionId,
  );

  console.log(`\nЖИВОЙ ЗАМЕР · ${WIDTH}×${HEIGHT}\n`);
  console.log(`  GPU:                       ${renderer.result.value}`);
  console.log(`  вызовов отрисовки (живьём) ${probe.drawCalls}`);
  console.log(`  мешей (считано)            ${probe.budget.meshes}`);
  console.log(`  материалов                 ${probe.budget.materials}`);
  console.log(`  кадров за 3 с              ${probe.frames}`);
  console.log(
    `  мс на кадр                 ${probe.msPerFrame.toFixed(2)}  ← ПРОКСИ, не FPS телефона`,
  );

  if (probe.layout !== undefined) {
    const l = probe.layout;
    console.log('\n  ЛЕЙАУТ');
    console.log(`    горизонтальное переполнение  ${l.horizontalOverflow} px  (обязан быть 0)`);
    console.log(
      `    панель налезает на сцену     ${Math.round(l.barOverlapsStage)} px  (обязан быть 0)`,
    );
    console.log(`    панель целиком на экране     ${l.barVisible ? 'да' : 'НЕТ'}`);
    console.log(`    сцена ${l.stageHeight} px · панель ${l.barHeight} px`);
    console.log(`    строка: ${l.readout}`);
  }

  if (probe.drawCalls > probe.budget.meshes) {
    console.log(
      `\n  ⚠ ГРАНИЦА СЛОМАНА: живьём ${probe.drawCalls} вызовов при ${probe.budget.meshes} посчитанных.`,
    );
    console.log('    Посчитанное число обязано ограничивать реальное СВЕРХУ.');
    console.log('    Причины ищи в apps/web/src/render/budget.ts: массив материалов');
    console.log('    на меше или лишний проход рисования (тени, постобработка).');
  } else if (probe.drawCalls < probe.budget.meshes) {
    const culled = probe.budget.meshes - probe.drawCalls;
    console.log(`\n  Отсечено по пирамиде видимости: ${culled}. Граница держится.`);
  }

  if (SHOT !== '') {
    const shot = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    mkdirSync(dirname(SHOT), { recursive: true });
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`\n  скриншот: ${SHOT}`);
  }

  console.log('');
  client.close();
} finally {
  chrome.kill();
}
