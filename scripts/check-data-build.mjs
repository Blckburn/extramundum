#!/usr/bin/env node
/**
 * СОБРАННЫЕ ДАННЫЕ СОВПАДАЮТ С ИСХОДНЫМИ.
 *
 * У `packages/data` два состояния на диске: исходные `*.json` и их
 * копии в `dist/`, которые кладёт туда `tsc --build`. Игра читает
 * копии — сервер импортирует `@extramundum/data/zones`, а тот
 * `./zones.json` РЯДОМ С СОБОЙ, то есть из `dist`. Матрица читала
 * исходники.
 *
 * Один файл, два пути, и расходятся они МОЛЧА. Поймано на снимке
 * экрана: замер печатал откалиброванные множители участков, а карточка
 * зоны показывала прежние — `dist` не пересобрали. В репозиторий это
 * не попадает (`dist` в `.gitignore`, прод собирает всегда), но
 * локально даёт откалиброванную игру, отличную от запущенной.
 *
 * Правка двойная, и одной половины мало:
 *
 *   1. Матрица теперь читает `dist` — тот же артефакт, что и сервер.
 *      Так они не могут разойтись между собой.
 *   2. Эта проверка ловит, что сам `dist` отстал от исходников.
 *      Без неё правка 1 превратила бы «два разных состояния»
 *      в «одно общее устаревшее», и замер молча мерил бы вчерашнюю
 *      игру.
 *
 * Сравниваются РАЗОБРАННЫЕ ДАННЫЕ, а не байты и не время правки.
 *
 * Не время: `git checkout` меняет его у файлов, которых не касался,
 * и проверка по mtime врала бы в обе стороны.
 *
 * Не байты: `tsc --build` переиндентирует JSON по-своему — исходник
 * в два пробела, копия в четыре. Побайтовое сравнение объявляло бы
 * устаревшими ВСЕ файлы всегда, то есть не отличало бы настоящее
 * расхождение от форматирования. Проверка, которая кричит постоянно,
 * через неделю читается как фон.
 *
 * Ловится и третий случай: файл, который есть в `dist` и которого
 * больше нет в исходниках. Так там пережил своё удаление риг `beast`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../packages/data/', import.meta.url));
const DIST = join(ROOT, 'dist');

/** Файлы сборочной системы, а не данные: в `dist` их и не должно быть. */
const NOT_DATA = new Set(['package.json', 'tsconfig.json']);

function jsonFilesUnder(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonFilesUnder(full, base));
    else if (entry.name.endsWith('.json') && !NOT_DATA.has(entry.name)) {
      out.push(relative(base, full));
    }
  }
  return out;
}

/** Данные файла в каноническом виде. `null` — файла нет или он битый. */
function dataOf(path) {
  try {
    return JSON.stringify(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

const quiet = process.argv.includes('--quiet');

let built;
try {
  built = statSync(DIST).isDirectory();
} catch {
  built = false;
}

if (!built) {
  console.error('ДАННЫЕ НЕ СОБРАНЫ: packages/data/dist отсутствует. Запусти `pnpm build`.');
  process.exit(1);
}

const sources = jsonFilesUnder(ROOT);
const missing = [];
const stale = [];

for (const rel of sources) {
  const from = dataOf(join(ROOT, rel));
  const to = dataOf(join(DIST, rel));
  if (to === null) missing.push(rel);
  else if (from !== to) stale.push(rel);
}

/* Обратная сторона: что лежит в `dist` и чего больше нет в исходниках.
   Такой файл не «лишний байт», а данные, которые кто-то ещё может
   прочитать: удалённый риг оставался доступен сборке. */
const distFiles = jsonFilesUnder(DIST, DIST);
const sourceSet = new Set(sources);
const orphans = distFiles.filter((rel) => !sourceSet.has(rel));

const problems = missing.length + stale.length + orphans.length;

if (problems === 0) {
  if (!quiet) {
    console.log(`✓ Собранные данные совпадают с исходными: ${sources.length} файлов.`);
  }
  process.exit(0);
}

console.error('СОБРАННЫЕ ДАННЫЕ РАЗОШЛИСЬ С ИСХОДНЫМИ.');
console.error('Замер и игра прочитают разное, и разойдутся молча.\n');

for (const rel of stale) console.error(`  устарел в dist:  ${rel}`);
for (const rel of missing) console.error(`  нет в dist:      ${rel}`);
for (const rel of orphans) console.error(`  лишний в dist:   ${rel} (в исходниках его нет)`);

console.error('\nЗапусти `pnpm build`. Если не помогло — удали packages/data/dist:');
console.error('`tsc --build` не убирает файлы, исчезнувшие из исходников.');
process.exit(1);
