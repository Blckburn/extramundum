#!/usr/bin/env node
/**
 * Матрица винрейтов. GDD §4.6, пункт 2.
 *
 * «10 000 симуляций на каждую пару архетипов. Требование: ни один
 * архетип не выигрывает у другого чаще 65% и реже 35% при равном
 * уровне снаряжения».
 *
 * Это то, чего в v1.0 не было вообще, и причина, по которой тот баланс
 * невозможно было настроить: любое суждение о силе билда опиралось
 * на ощущение от нескольких боёв.
 *
 * Скрипт ничего не подгоняет. Он печатает числа и выходит с кодом 1,
 * если коридор нарушен. Расширять коридор, чтобы сборка позеленела, —
 * ровно тот способ, которым баланс v1.0 и остался неотлаженным.
 *
 *   node scripts/winrate-matrix.mjs             # 10 000 боёв на пару
 *   node scripts/winrate-matrix.mjs --runs 500  # быстрая проверка
 *   node scripts/winrate-matrix.mjs --json      # машиночитаемый вывод
 *
 * Сид фиксирован: `pair-<a>-<b>-<i>`. Один и тот же прогон даёт один
 * и тот же результат, иначе «стало лучше» нельзя отличить от шума.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const balance = JSON.parse(readFileSync(new URL('packages/data/balance.json', root), 'utf8'));

const { resolveBattle } = await import(fileURLToPath(new URL('packages/sim/dist/index.js', root)));

/* ────────────────────────────── аргументы ───────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? fallback : argv[at + 1];
};
const RUNS = Number(flag('runs', 10000));
const AS_JSON = argv.includes('--json');
const LOW = 0.35;
const HIGH = 0.65;

/* ─────────────────────────────── бойцы ──────────────────────────────── */

const ARCHETYPES = Object.keys(balance.archetypes).filter(
  (k) => !k.startsWith('$') && k !== 'calibration',
);

/**
 * Боец «при равном уровне снаряжения» (формулировка §4.6).
 *
 * Оружие у всех одно и то же, и это намеренно: матрица проверяет
 * стартовые статы и трейты, а не лут. Как только предметы появятся
 * в M3, сюда придёт вторая матрица — «в тир-снаряжении», пункт 4.
 */
function build(archetype, extraTraits = []) {
  const a = balance.archetypes[archetype];
  return {
    level: 1,
    atk: a.atk,
    def: a.def,
    agi: a.agi,
    spd: a.spd,
    pathBonusHp: 0,
    accuracy: a.accuracy,
    armor: a.armor,
    armorClass: 'medium',
    critBonus: 0,
    weapon: { dmgMin: 8, dmgMax: 14, ilvl: 1, class: 'balanced' },
    offhand: null,
    damageAffixes: [],
    statuses: [],
    traits: [a.trait, ...extraTraits],
  };
}

/**
 * Доля побед ПЕРВОГО бойца в серии.
 *
 * Стороны меняются местами на каждой второй итерации, а результат
 * приводится к первому бойцу. Без этого матрица мерила бы не силу
 * архетипа, а преимущество первого хода: при равной инициативе порядок
 * решает бросок, но при разном SPD быстрый бьёт первым всегда.
 */
function duel(a, b, label, runs = RUNS) {
  let wins = 0;
  let draws = 0;
  let ticks = 0;

  for (let i = 0; i < runs; i++) {
    const swap = i % 2 === 1;
    const setup = swap ? [b, a] : [a, b];
    const { outcome } = resolveBattle(setup, balance, `${label}-${i}`);
    ticks += outcome.ticks;

    if (outcome.winner === null) draws++;
    else if ((outcome.winner === 0) !== swap) wins++;
  }

  return { wins, draws, runs, rate: wins / runs, avgTicks: ticks / runs };
}

/* ───────────────────────── матрица архетипов ────────────────────────── */

const pairs = [];
for (let i = 0; i < ARCHETYPES.length; i++) {
  for (let j = i + 1; j < ARCHETYPES.length; j++) {
    const [a, b] = [ARCHETYPES[i], ARCHETYPES[j]];
    pairs.push({ a, b, ...duel(build(a), build(b), `pair-${a}-${b}`) });
  }
}

/* ──────────────────────── связки внутри школы ───────────────────────── */

/**
 * Связки внутри школы. НАБЛЮДАЕМАЯ ВЕЛИЧИНА, не коридор.
 *
 * Трейты одной школы умножают друг друга, и связка может уйти далеко
 * вверх там, где каждый её участник по отдельности держится в рамках.
 * Проверяются те, у которых множители складываются в цепочку: MAG —
 * `plaguebearer` вешает яд, `hexblade` — хекс, `amplifier` усиливает
 * и то и другое; STR — `cursed` множит урон, `berserker` множит его же
 * от нехватки HP, `executioner` — от нехватки её у цели.
 *
 * Рамку сюда сознательно НЕ ставят. Связка обязана быть сильнее
 * одиночного трейта, иначе школы не значат ничего; а где проходит
 * «слишком сильно», станет видно только с предметами и аффиксами (M3),
 * которые лягут сверху и умножатся с тем же самым. Сейчас это цифры,
 * за которыми следят, а не порог, который роняет сборку.
 */
const COMBOS = [
  ['MAG: яд + хекс + усилитель', 'forbidden', ['plaguebearer', 'hexblade', 'amplifier']],
  ['MAG: горение + усилитель + вытягивание', 'forbidden', ['pyromancer', 'amplifier', 'leech']],
  ['STR: проклятие + берсерк + палач', 'theft', ['cursed', 'berserker', 'executioner']],
  ['STR: кровь + мясник + хватка', 'theft', ['bloodlust', 'butcher', 'ironGrip']],
  ['DEF: крепость + шипы + второе дыхание', 'brawl', ['fortress', 'thorns', 'secondWind']],
  ['AGI: фантом + скользкий + замах', 'advocacy', ['phantom', 'slippery', 'windup']],
];

/** Против кого меряются связки: тот же архетип без добавленных трейтов. */
const comboRuns = Math.max(200, Math.round(RUNS / 4));
const combos = COMBOS.map(([label, archetype, traits]) => ({
  label,
  archetype,
  traits,
  ...duel(build(archetype, traits), build(archetype), `combo-${traits.join('-')}`, comboRuns),
}));

/* ──────────────────── одиночные трейты одной школы ──────────────────── */

/**
 * Сравнение соседей по школе.
 *
 * Абсолютное число здесь значит меньше, чем РАЗБРОС внутри школы. Трейт,
 * обгоняющий соседей на десятки процентов, — не выбор, а обязательный
 * пик: игрок, который его не взял, играет в заведомо худшую игру,
 * а весь остальной список школы становится украшением.
 *
 * Отдельная строка про `slippery` печатается ниже: он режет чужой крит
 * ВСЕГДА и без условия, тогда как соседи по AGI требуют либо крита, либо
 * уклонения, либо счётчика ходов. Подозрение на перекос проверяется
 * числом, а не остаётся подозрением.
 */
const { TRAITS } = await import(fileURLToPath(new URL('packages/sim/dist/traits.js', root)));

/** Выбираемые трейты по школам — из реестра движка, а не из копии здесь. */
const SCHOOL_PROBE = {};
for (const [id, def] of TRAITS) {
  if (id.startsWith('innate')) continue;
  (SCHOOL_PROBE[def.school] ??= []).push(id);
}
const HOST = { agi: 'advocacy', str: 'theft', def: 'brawl', mag: 'forbidden' };

const soloRuns = Math.max(200, Math.round(RUNS / 5));
const solo = {};
for (const [school, ids] of Object.entries(SCHOOL_PROBE)) {
  const host = HOST[school];
  solo[school] = ids.map((id) => ({
    id,
    ...duel(build(host, [id]), build(host), `solo-${id}`, soloRuns),
  }));
}

/* ─────────────────────────────── вывод ──────────────────────────────── */

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const breaches = pairs.filter((p) => p.rate < LOW || p.rate > HIGH);

if (AS_JSON) {
  console.log(
    JSON.stringify({ runs: RUNS, corridor: [LOW, HIGH], pairs, combos, solo, breaches }, null, 2),
  );
} else {
  console.log(`\nМАТРИЦА ВИНРЕЙТОВ · GDD §4.6, пункт 2`);
  console.log(`${RUNS} боёв на пару, стороны меняются местами, сид фиксирован.`);
  console.log(`Коридор: ${pct(LOW)}–${pct(HIGH)}. Коридор не подгоняется под результат.\n`);

  console.log(
    `${pad('архетип', 12)}${pad('против', 12)}${padL('винрейт', 9)}${padL('ничьи', 8)}${padL('тиков', 8)}   вердикт`,
  );
  console.log('─'.repeat(64));
  for (const p of pairs) {
    const ok = p.rate >= LOW && p.rate <= HIGH;
    console.log(
      pad(p.a, 12) +
        pad(p.b, 12) +
        padL(pct(p.rate), 9) +
        padL(pct(p.draws / p.runs), 8) +
        padL(p.avgTicks.toFixed(0), 8) +
        '   ' +
        (ok ? 'в коридоре' : 'ВНЕ КОРИДОРА'),
    );
  }

  console.log(
    `\nСВЯЗКИ ВНУТРИ ШКОЛЫ · ${comboRuns} боёв, против того же архетипа без этих трейтов`,
  );
  console.log('НАБЛЮДАЕМАЯ ВЕЛИЧИНА, НЕ КОРИДОР. Связка из трёх трейтов одной школы');
  console.log('обязана быть сильнее одиночного трейта — иначе школы не значат ничего');
  console.log('и собирать билд незачем. Числа печатаются, чтобы видеть, КАК множители');
  console.log('складываются, а не чтобы ронять сборку: рамку для них задавать рано.');
  console.log('');
  console.log('Всерьёз они понадобятся в M3. Предметы и аффиксы лягут СВЕРХУ на уже');
  console.log('сбалансированные трейты и умножатся с ними — там же, где сейчас видно,');
  console.log('как множители цепляются друг за друга. Тогда и придёт вторая матрица,');
  console.log('пункт 4 §4.6.');
  console.log('─'.repeat(64));
  for (const c of combos) {
    console.log(pad(c.label, 44) + padL(pct(c.rate), 9) + padL(c.avgTicks.toFixed(0), 8));
  }

  console.log(`\nОДИНОЧНЫЕ ТРЕЙТЫ · ${soloRuns} боёв, каждый против голого носителя`);
  console.log('Разброс внутри школы важнее абсолютных чисел: трейт, обгоняющий');
  console.log('соседей на десятки процентов, — это не выбор, а обязательный пик.');
  console.log('');
  console.log('СРАВНИВАТЬ ШКОЛЫ МЕЖДУ СОБОЙ ПО ЭТИМ ЧИСЛАМ НЕЛЬЗЯ: у каждой свой');
  console.log('носитель, а уровень зависит от него сильно. Бои brawl вдвое длиннее');
  console.log('прочих, поэтому любой эффект «за событие» на нём копится дольше:');
  console.log('замерено, что перенос retribution с brawl на theft меняет его');
  console.log('с 82% на 64% без единой правки чисел. Разброс ВНУТРИ школы честен,');
  console.log('потому что носитель у всех её трейтов один.');
  for (const [school, rows] of Object.entries(solo)) {
    const sorted = [...rows].sort((x, y) => y.rate - x.rate);
    const spread = sorted[0].rate - sorted[sorted.length - 1].rate;
    console.log(`\n  ${school.toUpperCase()}  разброс ${pct(spread)}`);
    for (const r of sorted) console.log(`    ${pad(r.id, 16)}${padL(pct(r.rate), 8)}`);
  }

  // Трейты, чьи числа взяты из GDD дословно. Их нельзя калибровать —
  // правка документа решение человека, — поэтому выход за рамки школы
  // печатается ОТДЕЛЬНО и словами. Молча исключить их из разброса
  // означало бы спрятать находку под зелёной сборкой.
  //
  // Список сократился с шести до четырёх: `cursed` и `thorns` вышли
  // из него вместе с правкой GDD 2.5, которую эта секция и вызвала.
  // Так оно и должно работать — исключение живёт до правки, не дольше.
  const GDD_FIXED = ['warlord', 'fortress', 'phantom', 'hexblade'];
  const fixedRows = Object.values(solo)
    .flat()
    .filter((r) => GDD_FIXED.includes(r.id));
  const stray = fixedRows.filter((r) => r.rate < 0.45 || r.rate > 0.78);

  console.log('\nЧИСЛА ИЗ GDD, КАЛИБРОВКЕ НЕ ПОДЛЕЖАТ');
  console.log(fixedRows.map((r) => `  ${pad(r.id, 12)}${padL(pct(r.rate), 8)}`).join('\n'));
  if (stray.length > 0) {
    console.log('\n  Вне рамок своей школы, но правка — решение человека:');
    for (const r of stray) console.log(`    ${r.id}: ${pct(r.rate)}`);
    console.log('  Сборку это не роняет: коридор §4.6 задан для АРХЕТИПОВ, не для трейтов.');
  }

  // Отдельная строка про `slippery`: он единственный в AGI работает
  // без условия, и вопрос «не сильнее ли он соседей» задан заранее,
  // а не после того, как игроки его найдут.
  const agi = [...solo.agi].sort((x, y) => y.rate - x.rate);
  const slip = agi.find((r) => r.id === 'slippery');
  if (slip !== undefined) {
    const place = agi.indexOf(slip) + 1;
    const top = agi[0];
    console.log(
      `\n  slippery: ${pct(slip.rate)}, место ${place} из ${agi.length} в своей школе ` +
        `(лучший — ${top.id}, ${pct(top.rate)}).`,
    );
    console.log('  Работает без условия, в отличие от соседей, — поэтому проверяется отдельно.');
  }

  console.log(`\nПУНКТ 4 §4.6 — КРИВАЯ ЗОН — НЕ ПРОВЕРЯЕТСЯ.`);
  console.log('Отложено до M3: ни зон, ни предметов, ни тир-снаряжения ещё нет.');
  console.log('Подставить манекенов означало бы проверять выдуманные числа');
  console.log('о выдуманных зонах — такая проверка хуже отсутствующей, потому');
  console.log('что выглядит как гарантия.\n');

  if (breaches.length > 0) {
    console.log(`КОРИДОР НАРУШЕН в ${breaches.length} пар(ах):`);
    for (const p of breaches) console.log(`  ${p.a} против ${p.b}: ${pct(p.rate)}`);
    console.log('Это находка, а не помеха. Править надо числа, а не коридор:');
    console.log('матрица держится на стартовых статах архетипов — смотреть');
    console.log('в balance.json → archetypes раньше, чем в трейты и статусы.\n');
  } else {
    console.log('Все пары в коридоре.\n');
  }
}

process.exit(breaches.length > 0 ? 1 : 0);
