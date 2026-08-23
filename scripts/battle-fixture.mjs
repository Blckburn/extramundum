#!/usr/bin/env node
/**
 * Эталонный боевой лог для тестов воспроизведения (M2b).
 *
 * ЗАЧЕМ ФАЙЛ, А НЕ ВЫЗОВ ДВИЖКА ИЗ ТЕСТА. Проигрыватель живёт
 * в `apps/web`, а движок туда не попадает — это инвариант 3, и держат
 * его четыре независимых рубежа. Импортировать `@extramundum/sim`
 * из клиентского теста значило бы пробить два из них ради удобства.
 *
 * ЗАЧЕМ НАСТОЯЩИЙ ЛОГ, А НЕ ПРИДУМАННЫЙ. Лог, написанный руками,
 * проверяет проигрыватель против представлений автора о формате,
 * а не против формата. Расхождение всплыло бы у игрока.
 *
 * Поэтому лог порождается движком и КОММИТИТСЯ, а `server/src/__tests__`
 * (которому движок доступен по праву) воспроизводит его из записанных
 * сида и состава и сверяет побайтово. Изменился движок — падает тот
 * тест, а не клиентские, и падает он с внятной причиной.
 *
 *   node scripts/battle-fixture.mjs          # перезаписать эталон
 *   node scripts/battle-fixture.mjs --check  # только проверить
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const OUT = fileURLToPath(new URL('apps/web/src/battle/__tests__/fixtures/battle.json', root));
const CHECK = process.argv.includes('--check');

const { resolveBattle, maxHp } = await import(
  fileURLToPath(new URL('packages/sim/dist/index.js', root))
);
const balance = JSON.parse(
  readFileSync(fileURLToPath(new URL('packages/data/balance.json', root)), 'utf8'),
);

/**
 * Состав подобран так, чтобы В ЛОГЕ ВСТРЕТИЛИСЬ ВСЕ типы событий.
 *
 * Это не украшение выборки, а условие осмысленности тестов. Тест вида
 * «проигрыватель не падает ни на одном событии» проходит и на логе
 * из одних ударов — то есть не доказывает ничего. Поэтому здесь есть
 * щит (блоки), школа MAG у обоих (статусы, их тики и истечение),
 * `thorns` (урон по атакующему, а не по цели) и врождённые трейты
 * (срабатывания). А тест сверх того ТРЕБУЕТ присутствия каждого типа
 * и падает, если хоть одного не оказалось.
 */
const SETUP = [
  {
    level: 4,
    atk: 14,
    def: 10,
    agi: 12,
    spd: 11,
    pathBonusHp: 0,
    accuracy: 0,
    armor: 6,
    armorClass: 'medium',
    critBonus: 0,
    weapon: { dmgMin: 8, dmgMax: 14, ilvl: 4, class: 'balanced' },
    shield: null,
    statuses: [],
    traits: ['plaguebearer', 'hexblade', 'innateScholar'],
  },
  {
    level: 4,
    atk: 12,
    def: 13,
    agi: 9,
    spd: 10,
    pathBonusHp: 0,
    accuracy: 0,
    armor: 9,
    armorClass: 'heavy',
    critBonus: 0,
    weapon: { dmgMin: 7, dmgMax: 12, ilvl: 4, class: 'heavy' },
    shield: { blockChance: 0.35, blockReduction: 0.7 },
    statuses: [],
    traits: ['thorns', 'pyromancer', 'innateGuard'],
  },
];

const REQUIRED = [
  'turn_start',
  'attack',
  'dodge',
  'block',
  'damage',
  'status_apply',
  'status_tick',
  'status_expire',
  'trait_fire',
  'death',
];

/** Первый сид, на котором встретились все типы событий. */
function findSeed() {
  for (let i = 0; i < 2000; i++) {
    const seed = `m2b-fixture-${i}`;
    const { log, outcome } = resolveBattle(SETUP, balance, seed);
    const kinds = new Set(log.events.map((e) => e.t));
    if (REQUIRED.every((kind) => kinds.has(kind))) return { seed, log, outcome };
  }
  throw new Error('не нашёлся сид, на котором встречаются все типы событий');
}

const { seed, log, outcome } = findSeed();

/**
 * Максимум HP считает ДВИЖОК, как и на сервере.
 *
 * Вывести его из лога нельзя: `hpAfter` уже уменьшен на удар. Пробной
 * странице он нужен для полос здоровья, и брать его оттуда же, откуда
 * берёт сервер, — единственный способ не завести вторую формулу.
 */
const fighterMaxHp = [maxHp(SETUP[0], balance), maxHp(SETUP[1], balance)];

const fixture = {
  $comment: [
    'Эталонный боевой лог. Порождён движком, не написан руками.',
    'Перезаписывается: node scripts/battle-fixture.mjs',
    'Сверяется: server/src/__tests__/fixture.test.ts — воспроизводит',
    'бой из этих же сида и состава и сравнивает целиком.',
  ],
  seed,
  setup: SETUP,
  maxHp: fighterMaxHp,
  outcome,
  log,
};

const serialized = `${JSON.stringify(fixture, null, 2)}\n`;

if (CHECK) {
  // Сравнение РАЗОБРАННОГО, а не текста: файл проходит через Prettier,
  // и посимвольная сверка ловила бы отступы вместо расхождения с движком.
  const existing = JSON.parse(readFileSync(OUT, 'utf8'));
  const same =
    JSON.stringify({ ...existing, $comment: null }) ===
    JSON.stringify({ ...fixture, $comment: null });
  if (!same) {
    console.error('Эталон устарел. Перезаписать: node scripts/battle-fixture.mjs');
    process.exit(1);
  }
  console.log('Эталон совпадает с выводом движка.');
} else {
  writeFileSync(OUT, serialized);
  const counts = {};
  for (const event of log.events) counts[event.t] = (counts[event.t] ?? 0) + 1;
  console.log(`Сид ${seed}, событий ${log.events.length}:`);
  for (const kind of REQUIRED) console.log(`  ${kind.padEnd(14)}${counts[kind]}`);
}
