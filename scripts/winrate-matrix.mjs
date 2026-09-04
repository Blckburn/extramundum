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
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const balance = JSON.parse(readFileSync(new URL('packages/data/balance.json', root), 'utf8'));

const { resolveBattle } = await import(fileURLToPath(new URL('packages/sim/dist/index.js', root)));
/* Реестр трейтов нужен прогрессии игрока: школа трейта — данные движка,
   и переписывать их сюда значило бы завести копию, которая разойдётся. */
const { TRAITS } = await import(fileURLToPath(new URL('packages/sim/dist/traits.js', root)));
/* Оффер драфта берётся у ПРОИЗВОДСТВЕННОЙ функции, а не повторяется
   здесь: колода фильтруется наклоном, и вторая реализация фильтра
   разошлась бы с первой молча — а значит матрица мерила бы билд,
   которого игра не выдаёт. */
/* Бросок и оффер берутся у ПРОИЗВОДСТВЕННЫХ функций: вторая
   реализация разошлась бы с первой молча, а на этом мы уже
   поймались — см. `seededRoll`. */
const { offerCards, seededRoll } = await import(
  fileURLToPath(new URL('packages/shared/dist/index.js', root))
);

/* ────────────────────────────── аргументы ───────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? fallback : argv[at + 1];
};
const RUNS = Number(flag('runs', 10000));
const AS_JSON = argv.includes('--json');
/**
 * Куда ЕЩЁ записать машиночитаемый отчёт, не отменяя человеческий вывод.
 *
 * Нужен ради CI: прежде тот гонял матрицу ДВАЖДЫ — раз для лога, раз
 * для `--json`. Вторая половина считала ровно то же самое и стоила
 * ровно столько же. С кривой зон на двадцати пяти сидах эта вторая
 * половина перестала помещаться в отведённое время.
 */
const JSON_OUT = flag('json-out', null);
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
function build(archetype, extraTraits = [], level = 1, ilvl = 1) {
  const a = balance.archetypes[archetype];
  /* Рост статов — АВТОПРИРОСТ прогрессии (§5.2), а не прежняя прокси
     `база × (1 + (уровень − 1) × sparring.statPerLevel / 12)`: настоящая
     формула теперь есть, и держать рядом прокси значит мерить бойца,
     которого игра не производит.

     КАРТ И ТРЕЙТОВ ДРАФТА ЗДЕСЬ НЕТ, и это решение, а не пропуск.
     Эта функция меряет силу АРХЕТИПА и ОДНОГО трейта в изоляции —
     ради этого коридор §4.6 и написан. Добавь сюда восемь трейтов
     драфта, и измеряемое утонет в них: разброс между архетипами стал
     бы разбросом между школами драфта. Настоящий растущий боец
     со всеми картами живёт в `tierGearedPlayer`, где он и нужен —
     в кривой зон. */
  const auto = (level - 1) * PROG.statPerLevel;
  const gear = 1 + ilvl * balance.items.ilvlScale;
  const stat = (v) => v + auto;

  return {
    level,
    atk: stat(a.atk),
    def: stat(a.def),
    agi: stat(a.agi),
    spd: stat(a.spd),
    pathBonusHp: 0,
    gearBonusHp: 0,
    accuracy: a.accuracy,
    armor: level === 1 ? a.armor : Math.round(a.armor * gear),
    armorClass: 'medium',
    critBonus: 0,
    startHp: null,
    weapon: { dmgMin: 8, dmgMax: 14, ilvl, class: 'balanced' },
    offhand: null,
    percentAffixes: { might: [], bastion: [], swiftness: [] },
    accuracyAffixes: [],
    statuses: [],
    traits: [a.trait, ...extraTraits],
  };
}

/* ─────────────────── ПРОГРЕССИЯ ИГРОКА · GDD §5.2 ───────────────────
 *
 * До M3c эталонный боец рос ПРОКСИ-формулой: статы умножались
 * на `1 + (уровень − 1) × sparring.statPerLevel / 12`, потому что
 * настоящей формулы роста ещё не существовало. Теперь она есть,
 * и держать рядом прокси значило бы калибровать зоны на бойце,
 * которого игра не производит, — ровно та ошибка, из-за которой
 * коридор архетипов однажды был выверен на игроке без базовой брони.
 *
 * ЧТО ЗДЕСЬ МОДЕЛИРУЕТСЯ И ПОЧЕМУ ИМЕННО ТАК:
 *
 * 1. Автоприрост — по единице в каждый стат за уровень. Спорить не о чем,
 *    это `progression.statPerLevel`.
 *
 * 2. Карты — НАПРАВЛЕННЫЙ билд, но собранный ИЗ НАСТОЯЩИХ ОФФЕРОВ.
 *    Оффер — три карты из колоды, отфильтрованной наклоном (§5.2);
 *    карты своего наклона в нём может и не быть. Игрок берёт самую
 *    глубокую карту своего наклона, если она предложена, иначе самую
 *    глубокую вообще.
 *
 *    Модель «всегда лучшая карта наклона» была бы ЛОЖЬЮ В СИЛЬНУЮ
 *    СТОРОНУ, и это не мелочь: она давала направленному ATK-билду
 *    +134% к шансу крита к сороковому уровню, то есть упор в потолок
 *    60% примерно с двенадцатого. Матрица мерила бы бойца, которого
 *    игра не выдаёт, — та же ошибка, что с непримененной бронёй
 *    архетипа, только в другую сторону.
 *
 * 3. Трейты — каждый пятый уровень, следующий трейт ШКОЛЫ этого наклона
 *    в порядке реестра. Врождённые исключены: они принадлежат причине
 *    изгнания, а не выбору.
 *
 * НАКЛОН — ОСЬ УСРЕДНЕНИЯ, а не параметр. Кривая зон меряется по всем
 * четырём и усредняется, ровно по той же причине, по которой она уже
 * усредняется по трём классам оружия: трудность зоны не должна зависеть
 * от того, какой билд собрал игрок. Разойдись числа по наклонам сильно —
 * это находка о балансе школ, и её видно в разбросе, а не в одном
 * усреднённом числе.
 */
const CARDS = JSON.parse(readFileSync(new URL('packages/data/cards.json', root), 'utf8')).cards;
const PROG = balance.progression;
const LEANS = ['atk', 'def', 'agi', 'spd'];
const LEAN_SCHOOL = { atk: 'str', def: 'def', agi: 'agi', spd: 'mag' };

/** Врождённые трейты — те, что раздаёт причина изгнания. В пул не входят. */
const INNATE = new Set(ARCHETYPES.map((k) => balance.archetypes[k].trait));

function schoolPool(school) {
  return [...TRAITS.values()]
    .filter((t) => t.school === school && !INNATE.has(t.id))
    .map((t) => t.id);
}

const TIER_RANK = { base: 0, synergy: 1, deep: 2 };

/**
 * Что игрок набрал к данному уровню, ведя один наклон.
 *
 * Возвращает прибавки в тех же полях, что у бойца, — второго словаря
 * «имя эффекта → что менять» здесь заводить нельзя, он и есть то место,
 * где карта начинает делать не то, что написано.
 */
const ARCHETYPE = balance.archetypes.forbidden;

function progressionAt(level, lean) {
  const out = {
    atk: 0,
    def: 0,
    agi: 0,
    spd: 0,
    armor: 0,
    accuracy: 0,
    pathBonusHp: 0,
    critBonus: 0,
    auto: (level - 1) * PROG.statPerLevel,
    traits: [],
  };

  const leans = { atk: 0, def: 0, agi: 0, spd: 0 };
  const pool = schoolPool(LEAN_SCHOOL[lean]);
  // Сид фиксирован наклоном: прогон обязан воспроизводиться, иначе
  // «стало лучше» неотличимо от другого расклада карт.
  const seed = `matrix-draft-${lean}`;

  for (let lv = 2; lv <= level; lv++) {
    if (lv % PROG.traitEveryNLevels === 0) {
      const next = pool[out.traits.length];
      if (next !== undefined) out.traits.push(next);
      continue;
    }

    /* Оффер фильтруется ещё и ПОТОЛКАМИ: карта, чей эффект упёрся,
       из колоды исчезает. Без этого модель повторяла бы прежнюю
       ошибку — брала бы игроку карты точности при уже обнулённом
       уклонении врага и мерила билд, которого игра не выдаёт. */
    const ceilings = {
      values: {
        agi: ARCHETYPE.agi + out.auto + out.agi,
        critBonus: out.critBonus,
        accuracy: ARCHETYPE.accuracy + out.accuracy,
      },
      combat: balance,
    };
    const offer = offerCards(CARDS, leans, seed, lv, PROG, ceilings);
    if (offer.length === 0) continue;

    /* Своего наклона нет в оффере — берётся ПЕРВАЯ предложенная,
       а не «самая глубокая вообще». Порядок оффера уже задан сидом,
       то есть выбор нейтрален; «самая глубокая» же сортировалась при
       ничьей по порядку в файле и потому систематически доставалась
       одному наклону. Замерено: при ней ATK-карты забирал даже игрок,
       ведущий скорость, и наклоны расходились втрое (58 против 22
       к сороковому уровню) — модель мерила порядок строк в json. */
    const mine = offer.filter((c) => c.lean === lean);
    const choice =
      mine.length > 0
        ? [...mine].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])[0]
        : offer[0];

    leans[choice.lean] += 1;
    for (const [key, value] of Object.entries(choice.effects)) out[key] += value;
  }

  return out;
}

/**
 * Доля побед ПЕРВОГО бойца в серии.
 *
 * Стороны меняются местами на каждой второй итерации, а результат
 * приводится к первому бойцу. Без этого матрица мерила бы не силу
 * архетипа, а преимущество первого хода: при равной инициативе порядок
 * решает бросок, но при разном SPD быстрый бьёт первым всегда.
 */
function duel(a, b, label, runs = RUNS, rules = balance) {
  let wins = 0;
  let draws = 0;
  let ticks = 0;

  for (let i = 0; i < runs; i++) {
    const swap = i % 2 === 1;
    const setup = swap ? [b, a] : [a, b];
    const { outcome } = resolveBattle(setup, rules, `${label}-${i}`);
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

/**
 * Выбираемые трейты по школам — из реестра движка, а не из копии здесь.
 *
 * Исключены врождённые (приходят с прошлым персонажа, выбрать нельзя)
 * и трейты со школой `monster`: механики босса из §7.5 принадлежат
 * противнику, и мерить их разбросом внутри школы игрока бессмысленно.
 * Исключение идёт ПО ШКОЛЕ, а не по списку имён: список пришлось бы
 * пополнять с каждым новым монстровым трейтом, и однажды его забыли бы.
 */
const HOST = { agi: 'advocacy', str: 'theft', def: 'brawl', mag: 'forbidden' };

const SCHOOL_PROBE = {};
for (const [id, def] of TRAITS) {
  if (id.startsWith('innate')) continue;
  if (HOST[def.school] === undefined) continue;
  (SCHOOL_PROBE[def.school] ??= []).push(id);
}

const soloRuns = Math.max(200, Math.round(RUNS / 5));
const solo = {};
for (const [school, ids] of Object.entries(SCHOOL_PROBE)) {
  const host = HOST[school];
  solo[school] = ids.map((id) => ({
    id,
    ...duel(build(host, [id]), build(host), `solo-${id}`, soloRuns),
  }));
}

/* ─────────── бюджеты процентных семейств (§4.6, пункт 4) ───────────── */

/**
 * ПРОВЕРКА БЮДЖЕТОВ ЗАМЕРОМ. GDD §6.1 назначил бюджет «Мощи» расчётом:
 * «четыре аффикса T1 против четырёх T5 дают ×1.5 урона, то есть тир
 * снаряжения решал бы бой в одиночку; при двух — ×1.23, около 82%».
 * Расчёт — не замер, и до M3a проверить его было нечем: аффиксов
 * не существовало.
 *
 * В M3b тем же способом проверяются «Оплот» и «Проворство»: они тоже
 * процентные и тоже перемножаются, то есть способны сложиться так же.
 * Одна процедура на все три, а не три похожих: скопированный замер
 * разошёлся бы с первой правкой одного из них.
 *
 * Считается ровно то, что обещано: носитель четырёх T1 против носителя
 * четырёх T5, и то же самое при двух. Плюс контрольный прогон
 * с ОТКЛЮЧЁННЫМ бюджетом — иначе «при двух мягче» не с чем сравнить.
 */
const PERCENT_FAMILIES = ['might', 'bastion', 'swiftness'];

const midOf = (family, tier) => {
  const ladder = balance.items.affixFamilies[family];
  return (ladder[tier][0] + ladder[tier][1]) / 2;
};

/**
 * УРОВЕНЬ ЗАМЕРА — 34-й, а не первый, и это исправление, а не настройка.
 *
 * T1 выпадает только с ilvl 34 (§6.1). Сравнение «четыре T1 против
 * четырёх T5» на первом уровне описывает матчап, которого не бывает,
 * — и для семейств, чья сила зависит от уровня, оно врёт. Поймано
 * на «Оплоте»: на первом уровне четыре T1 давали 100% побед и с бюджетом,
 * и без, то есть замер переставал различать, держит ограничение
 * или нет. У «Мощи» этого не видно, потому что процент УРОНА от уровня
 * не зависит; её число при первом уровне записано в balance.json
 * ($mightBudget) и совпадает с расчётом GDD.
 */
const BUDGET_LEVEL = 34;

function withFamily(family, count, tier) {
  const empty = { might: [], bastion: [], swiftness: [] };
  return {
    ...build('theft', [], BUDGET_LEVEL, BUDGET_LEVEL),
    percentAffixes: {
      ...empty,
      [family]: Array.from({ length: count }, () => midOf(family, tier)),
    },
  };
}

const budgetRuns = Math.max(400, Math.round(RUNS / 4));

/**
 * КОНТРОЛЬНЫЙ ПРОГОН БЕЗ БЮДЖЕТА.
 *
 * Без него «при двух мягче» не с чем сравнивать: обе строки сняты
 * с работающим бюджетом и потому обязаны совпасть. Проверять надо
 * ровно то, что утверждает GDD, — что БЕЗ ограничения счёта четыре
 * аффикса дают ×1.5 и решают бой в одиночку.
 *
 * Бюджет отключается подменой коэффициента, а не правкой движка:
 * матрица не имеет права трогать то, что меряет.
 */
const withoutBudget = (family) => ({
  ...balance,
  items: {
    ...balance.items,
    familyBudget: { ...balance.items.familyBudget, [family]: 99 },
  },
});

/** Множитель от N аффиксов тира при заданном бюджете. */
const multiplier = (family, count, tier, cap) =>
  Array.from({ length: count }, () => midOf(family, tier))
    .slice(0, cap)
    .reduce((acc, v) => acc * (1 + v), 1);

const budgetProbe = [];
for (const family of PERCENT_FAMILIES) {
  const budget = balance.items.familyBudget[family];
  for (const count of [4, 2]) {
    for (const [mode, rules, cap] of [
      ['с бюджетом', balance, budget],
      ['без бюджета', withoutBudget(family), 99],
    ]) {
      budgetProbe.push({
        family,
        budget,
        count,
        mode,
        ratio: multiplier(family, count, 'T1', cap) / multiplier(family, count, 'T5', cap),
        /* Метка сида ОДНА на все прогоны семейства, и это не мелочь.
           Процентные аффиксы не тратят бросков (на это есть тест), поэтому
           при одном сиде строки с одинаковым множителем обязаны совпасть
           ПОБИТОВО, а отличаться должна ровно та, где бюджет снят.
           С разными метками строки расходились на 3.8 п.п., и это была
           разница ВЫБОРОК, а не баланса: ровно то, за что матрица ругает
           условные броски. */
        ...duel(
          withFamily(family, count, 'T1'),
          withFamily(family, count, 'T5'),
          family,
          budgetRuns,
          rules,
        ),
      });
    }
  }
}

/* ──────────────────── кривая зон (§4.6, пункт 4) ─────────────────────── */

/**
 * КРИВАЯ ЗОН. «Ожидаемый винрейт игрока в тир-снаряжении по зонам:
 * 85% / 75% / 65% / 55% / 45%.»
 *
 * До M3b этот пункт был не реализован и честно печатался как
 * не проверяемый: зон не существовало, и подставить вместо них манекенов
 * значило бы проверять выдуманные числа о выдуманных зонах.
 *
 * ЧТО ЗДЕСЬ СЧИТАЕТСЯ. Игрок берётся на ВЕРХНЕМ уровне зоны и в полном
 * эпическом комплекте того же ilvl — это и есть «тир-снаряжение».
 * Противники — обычные монстры зоны (босс отдельной строкой: он пятый
 * бой, а не типичный враг, и смешивать их значило бы занижать оценку
 * первых четырёх). Сложность нормальная.
 *
 * Рычаг калибровки — `power` в zones.json, множитель силы врагов зоны.
 * Уровень один кривой не даёт: игрок приходит в зону уровнем по ней,
 * и без множителя пятая зона была бы ровно так же трудна, как первая.
 */
const zones = JSON.parse(readFileSync(new URL('packages/data/zones.json', root), 'utf8')).zones;
const monsterSpecs = Object.fromEntries(
  JSON.parse(readFileSync(new URL('packages/data/monsters.json', root), 'utf8')).monsters.map(
    (m) => [m.key, m],
  ),
);
/* Базы читаются из json НАПРЯМУЮ, поэтому умолчания схемы надо
   подставить руками: `minIlvl` в файле указан не у всех, а генератор
   сравнивает его с уровнем и на `undefined` отбрасывает базу молча.
   Ловится это не ошибкой, а пустым пулом слота — то есть «у игрока
   почему-то нет амулета». */
const itemBases = Object.fromEntries(
  JSON.parse(readFileSync(new URL('packages/data/items/bases.json', root), 'utf8')).bases.map(
    (b) => [b.key, { minIlvl: 1, ...b }],
  ),
);

/**
 * ЦЕЛЬ — ФОРМА КРИВОЙ, А НЕ ЕЁ АБСОЛЮТНАЯ ВЫСОТА (решение человека).
 *
 * Прежде проверялось равенство абсолютным числам 85/75/65/55/45
 * на ОДНОМ зафиксированном сиде роллов снаряжения. Замер девяти сидов
 * показал, чего это стоило: размах кривой 18-41 п.п. при допуске ±7,
 * а сид подбора СИСТЕМАТИЧЕСКИ стоит с краю распределения — в Катакомбах
 * он минимум из девяти, в Чумных ямах максимум. Иначе и быть не могло:
 * калибровка двигала множитель зоны, пока ИМЕННО ЭТОТ сид не сядет
 * на цель, а остальные оставались где были. То есть «Пустоши на 85%»
 * было утверждением про сид, а не про игру.
 *
 * Устойчива не высота, а РАЗНИЦА — это видно на том же материале:
 * при смене сидов абсолютное число тиров сложности уехало на 14 п.п.,
 * а разрывы между тирами остались (18.9 и 21.6 против 23.6 и 18.8).
 *
 * Поэтому проверяется ШАГ между соседними зонами, и проверяется
 * по МЕДИАНЕ нескольких сидов. Медиана, а не среднее: одна зона
 * с вырожденным комплектом (Пустоши на плохом сиде дают 50.8% против
 * 91.7% на хорошем) утащила бы среднее, а медиана её игнорирует.
 */
const ZONE_STEP = 0.1;
/**
 * ДОПУСК НА ШАГ ВЗЯТ ИЗ ЗАМЕРА РАЗБРОСА САМОЙ МЕДИАНЫ, а не назначен,
 * и это оказалось важнее, чем выглядит.
 *
 * Первая попытка ставила ±5 при девяти сидах. Проверка двумя
 * независимыми наборами по девять показала, что так нельзя: медианы
 * разошлись на 9-11 п.п., а шаги — до 11. Допуск был бы вдвое уже
 * шума собственного измерителя, то есть сборка краснела бы от удачи.
 *
 * Замерено бутстрэпом по 49 сидам — ширина 10-90 процентиля шага:
 *
 *   пара                 n=9    n=15   n=25
 *   Пустоши→лагерь      16.7    12.0    9.1
 *   лагерь→Катакомбы    21.8    16.5   10.5
 *   Катакомбы→Кузня     22.4    15.6   10.7
 *   Кузня→Ямы           15.4    11.9    7.5
 *
 * При девяти сидах разброс шага БОЛЬШЕ самого шага в 10 п.п. — проверка
 * была бы бессмысленна при любом допуске. При двадцати пяти ширина
 * 7.5-10.7, то есть полуширина около 5, и ±6 оставляет запас.
 */
const ZONE_STEP_TOLERANCE = 0.06;
/**
 * Абсолютные числа ОСТАЛИСЬ ОРИЕНТИРОМ и печатаются, но прогон ими
 * больше не валится. Убрать их совсем нельзя: без якоря форма
 * выполняется и кривой 40/30/20/10/0, где играть невозможно нигде.
 */
const ZONE_TARGETS = [0.85, 0.75, 0.65, 0.55, 0.45];
/** Допуск ориентира. Печатается, прогон им не валится. */
const ZONE_TOLERANCE = 0.07;
/**
 * ВЫСОТА КРИВОЙ ВСЁ ЖЕ СТОРОЖИТСЯ, но грубо и по медиане: форма
 * без якоря — это форма, которую можно выполнить на невозможной игре.
 * Число широкое намеренно, оно ловит обвал, а не смещение.
 */
const ZONE_ANCHOR_TOLERANCE = 0.15;

const { generateItem } = await import(fileURLToPath(new URL('packages/sim/dist/index.js', root)));

/** Монстр как боец. Повторяет server/src/battle/monsters.ts по данным. */
function monsterFighter(spec, level, power) {
  const curve = balance.monsters;
  const stat = curve.baseStat + (level - 1) * curve.statPerLevel;
  const armor = curve.armorBase + level * curve.armorPerLevel;
  const sc = (m) => Math.round(stat * m * power);

  return {
    level,
    atk: sc(spec.stats.atk),
    def: sc(spec.stats.def),
    agi: sc(spec.stats.agi),
    spd: sc(spec.stats.spd),
    pathBonusHp: 0,
    gearBonusHp: 0,
    accuracy: 0,
    armor: Math.round(armor * spec.armor * power),
    armorClass: spec.armorClass,
    critBonus: 0,
    startHp: null,
    weapon: {
      dmgMin: curve.weapon.dmgMin * spec.weapon.dmgMin,
      dmgMax: curve.weapon.dmgMax * spec.weapon.dmgMax,
      ilvl: level,
      class: spec.weaponClass,
    },
    offhand: null,
    percentAffixes: { might: [], bastion: [], swiftness: [] },
    accuracyAffixes: [],
    statuses: [],
    traits: spec.traits,
  };
}

/**
 * Игрок «в тир-снаряжении»: полный эпический комплект под уровень зоны.
 *
 * Сборка повторяет server/src/items/loadout.ts. Это дубль, и он назван:
 * импортировать серверную сборку сюда нельзя — она тянет доступ к базе,
 * а матрица обязана считаться без неё. Что дубль не разошёлся, видно
 * по самой кривой: разойдись он — числа поехали бы разом во всех зонах.
 */
function tierGearedPlayer(archetype, level, ilvl, seedTag, forceWeaponClass, lean = 'def') {
  const a = balance.archetypes[archetype];
  /* НАСТОЯЩАЯ ПРОГРЕССИЯ, а не прокси-масштаб: автоприрост, карты
     из настоящих офферов и трейты пятых уровней. Прежде здесь стояло
     `база × (1 + (уровень − 1) × 1.6 / 12)` — прокси эпохи, когда
     формулы роста ещё не было. */
  const prog = progressionAt(level, lean);
  const gear = 1 + ilvl * balance.items.ilvlScale;
  const slots = ['weapon', 'offhand', 'helmet', 'chest', 'bracers', 'boots', 'amulet', 'ring'];

  let armor = a.armor;
  let atk = 0;
  let hp = 0;
  const accuracyAffixes = [];
  let weapon = null;
  let offhand = null;
  let armorClass = 'medium';
  const percentAffixes = { might: [], bastion: [], swiftness: [] };

  for (const slot of slots) {
    /* КЛАСС ОРУЖИЯ И НАКЛОН ВХОДЯТ В СИД ПРЕДМЕТА, и это исправление
       ошибки, а не мелочь.

       Прежде сид был `${seedTag}-${slot}-${ilvl}`: ни класса, ни
       наклона. Двенадцать «комплектов» кривой зон (3 класса × 4 наклона)
       отличались друг от друга билдом и оружием, а БРОНЮ носили
       ОДНУ И ТУ ЖЕ — роллы у них совпадали побитово. То есть усреднение
       по двенадцати комплектам не усредняло удачу роллов НИСКОЛЬКО:
       один сид был одним броском на всю зону.

       Отсюда и брались 18-41 п.п. разброса по сидам, и отсюда же
       кривая, «стоявшая на цели» на сиде подбора и разваливавшаяся
       на любом другом. Теперь один сид — двенадцать независимых
       бросков, и разброс падает примерно втрое. */
    const item = generateItem(
      `${seedTag}-${slot}-${ilvl}-${forceWeaponClass ?? 'any'}-${lean}`,
      { ilvl, slot, rarity: 'epic' },
      balance.items,
      Object.values(itemBases),
    );
    const base = itemBases[item.baseKey];

    if (base.armor !== undefined) armor += base.armor * gear;
    if (base.slot === 'chest' && base.armorClass !== undefined) armorClass = base.armorClass;
    if (base.slot === 'weapon') {
      /* Класс оружия задаётся СНАРУЖИ, а не достаётся броском.
         Кривая зон меряется усреднением по трём классам: игрок оружие
         ВЫБИРАЕТ под зону (§4.3, ради этого таблица матчапов и написана),
         и мерить зону одним случайно выпавшим классом значит мерить,
         повезло ли сегодня. Первый замер так и вышел: в Пустошах эталону
         достался лёгкий клинок против средней брони босса, и босс
         показал 0% — не потому что непроходим, а потому что комплект
         был худшим из возможных. */
      const chosen =
        forceWeaponClass === undefined
          ? base
          : (Object.values(itemBases).find(
              (b) => b.slot === 'weapon' && b.weaponClass === forceWeaponClass && b.minIlvl <= ilvl,
            ) ?? base);
      weapon = {
        dmgMin: chosen.dmgMin * gear,
        dmgMax: chosen.dmgMax * gear,
        ilvl,
        class: chosen.weaponClass,
      };
    }
    if (base.slot === 'offhand' && base.offhandKind === 'shield') {
      offhand = {
        kind: 'shield',
        blockChance: base.blockChance,
        blockReduction: base.blockReduction,
      };
    }

    for (const affix of item.affixes) {
      if (affix.family === 'strength') atk += affix.value;
      else if (affix.family === 'fortitude') armor += affix.value;
      else if (affix.family === 'vitality') hp += affix.value;
      // СПИСКОМ, а не суммой: у семейства бюджет, и сильнейшие
      // из суммы обратно не выделить.
      else if (affix.family === 'truehand') accuracyAffixes.push(affix.value);
      else percentAffixes[affix.family].push(affix.value);
    }
  }

  return {
    level,
    atk: a.atk + prog.auto + prog.atk + atk,
    def: a.def + prog.auto + prog.def,
    agi: a.agi + prog.auto + prog.agi,
    spd: a.spd + prog.auto + prog.spd,
    // Карты драфта — ОТДЕЛЬНОЕ поле от снаряжения: смешать два
    // источника HP в одном числе это форма бага v1.0 (§13, пункт 2).
    pathBonusHp: prog.pathBonusHp,
    gearBonusHp: hp,
    accuracy: a.accuracy + prog.accuracy,
    armor: Math.round(armor + prog.armor),
    armorClass,
    critBonus: prog.critBonus,
    startHp: null,
    weapon: weapon ?? { dmgMin: 8, dmgMax: 14, ilvl, class: 'balanced' },
    offhand,
    percentAffixes,
    accuracyAffixes,
    statuses: [],
    // Врождённый трейт причины изгнания плюс взятые на пятых уровнях.
    traits: [a.trait, ...prog.traits],
  };
}

/**
 * Боёв на один поединок в секции зон.
 *
 * Делитель БОЛЬШЕ, чем у пар архетипов, и это не экономия на точности,
 * а её перераспределение. Кривая зон усредняется по ДВЕНАДЦАТИ
 * комплектам (три класса оружия × четыре наклона), поэтому выборка
 * на зону — это runs × 12, а не runs. При прежнем делителе 5 ночной
 * прогон на 10 000 упирался в получасовой таймаут: секция зон выросла
 * впятеро вместе с числом комплектов.
 *
 * Точность на зону при этом та же: было 3 комплекта × 2000 = 6000
 * боёв, стало 12 × 500 = 6000. Разница в том, что теперь они сняты
 * с двенадцати разных бойцов, а не с трёх, — то есть оценка ЛУЧШЕ
 * при том же счёте.
 */
/**
 * СКОЛЬКО СИДОВ РОЛЛОВ СНАРЯЖЕНИЯ. Двадцать пять, и число ЗАМЕРЕНО,
 * а не выбрано с запасом.
 *
 * На одном сиде величина мерит удачу роллов вперемешку с настройкой,
 * и отделить одно от другого нельзя в принципе: размах кривой зон
 * по сидам 18-41 п.п. при прежнем допуске ±7.
 *
 * Девяти НЕ ХВАТИЛО, и это выяснилось проверкой, а не рассуждением:
 * два независимых набора по девять (`--seed-offset 9`) дали медианы,
 * расходящиеся на 9-11 п.п., а шаги — до 11 при целевом шаге 10.
 * Бутстрэп по 49 сидам подтвердил: разброс шага при n=9 составляет
 * 15-22 п.п., при n=25 — 7.5-10.7. Отсюда и двадцать пять: меньше
 * нельзя, а больше стоит времени без выигрыша для проверки.
 *
 * Нечётное — медиана берётся без усреднения соседей.
 *
 *   node scripts/winrate-matrix.mjs --seeds 5   # быстрее, грубее
 */
const SEEDS = Math.max(1, Number(flag('seeds', 25)));
/**
 * Сдвиг набора сидов. Нужен ровно для одного: проверить, что медиана
 * САМА не гуляет. Два независимых набора по девять — `--seed-offset 0`
 * и `--seed-offset 9` — обязаны давать близкие шаги, иначе допуск
 * на шаг взят с потолка, а не из замера.
 *
 * По умолчанию 0, и тогда сид 0 — исторический, на котором калибровали
 * до перехода к медиане.
 */
const SEED_OFFSET = Math.max(0, Number(flag('seed-offset', 0)));

/* БОЁВ НА СИД, а не на зону: с переходом к медиане счёт делится между
   сидами, иначе секция подорожала бы девятикратно и ночной прогон
   перестал бы укладываться в отведённое время.

   Точность от этого не страдает, а растёт. Главный источник разброса
   теперь НЕ бросок кубика внутри одного комплекта, а сам комплект:
   размах по сидам 18-41 п.п. против единиц процентных пунктов
   выборочного шума. Девять сидов по 200 боёв оценивают медиану лучше,
   чем один сид по 1800, — и это не рассуждение, а причина, по которой
   абсолютные числа на одном сиде оказались смещены. */
const zoneRuns = Math.max(
  60,
  Number(flag('zone-runs', Math.max(80, Math.round(RUNS / 20 / SEEDS)))),
);

/**
 * Режим подбора: печатает, какой `power` дал бы целевой винрейт.
 *
 * Живёт ЗДЕСЬ, а не отдельным скриптом, и это существенно: подбор
 * обязан идти тем же кодом, что и проверка. Отдельный скрипт разошёлся
 * бы с матрицей на первой же правке эталонного бойца — и подобранные
 * им числа не прошли бы её собственную проверку.
 *
 *   node scripts/winrate-matrix.mjs --calibrate
 */
const CALIBRATE = argv.includes('--calibrate');

/** Метка сида роллов. Нулевая — историческая, на ней всё калибровалось. */
const gearSeedTag = (zoneId, sd) => {
  const n = sd + SEED_OFFSET;
  return n === 0 ? `tier-${zoneId}` : `tier-${zoneId}-s${n}`;
};

/** Медиана. Массив не мутируется: он ещё нужен вызывающему. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ─────────── ПРИБОР НА ИЗВЕСТНОМ ОТВЕТЕ · CLAUDE.md ────────────
 *
 * Новый замер сначала проверяется на случае с ЗАРАНЕЕ ИЗВЕСТНЫМ
 * ответом, и только потом — на том, ради которого он писался. Правило
 * появилось после четырёх подряд ошибок в приборе, а не в игре: каждый
 * раз он печатал правдоподобные числа, и правдоподобие сходило
 * за правильность.
 *
 * Здесь известных ответов два, и они ловят разное.
 *
 * ПЕРВЫЙ: боец против самого себя даёт ровно половину. Ловит перекос
 * в самой дуэли — если первый ход, порядок инициативы или сид дают
 * кому-то фору, число уедет от 50% и всё остальное, что напечатает
 * матрица, будет смещено на ту же величину.
 *
 * ВТОРОЙ: множитель силы ОБЯЗАН менять исход. Ловит прибор, который
 * меряет не ту величину: если `power` до бойца не доезжает, все двадцать
 * подобранных чисел будут одинаково бессмысленны, а таблица — гладкой
 * и убедительной.
 */
{
  const probe = tierGearedPlayer('forbidden', 20, 20, 'known-answer', 'balanced', 'def');
  const mirror = duel(probe, probe, 'known-answer-mirror', 2000).rate;
  if (Math.abs(mirror - 0.5) > 0.03) {
    console.error(
      `ПРИБОР НЕВЕРЕН: боец против самого себя даёт ${(mirror * 100).toFixed(1)}%, ` +
        'а обязан давать 50%. Всё остальное в этом прогоне смещено на ту же величину.',
    );
    process.exit(2);
  }

  const enemy = monsterSpecs[zones[0].monsters[0]];
  const weak = duel(probe, monsterFighter(enemy, 8, 0.5), 'known-answer-weak', 400).rate;
  const strong = duel(probe, monsterFighter(enemy, 8, 3), 'known-answer-strong', 400).rate;
  if (!(weak > strong + 0.2)) {
    console.error(
      `ПРИБОР НЕВЕРЕН: множитель силы не меняет исход (${(weak * 100).toFixed(1)}% против ` +
        `${(strong * 100).toFixed(1)}%). Подбор множителей в таком прогоне бессмыслен.`,
    );
    process.exit(2);
  }
}

/**
 * ЗОНА МЕРИТСЯ НА ЧЕТВЁРТОМ УЧАСТКЕ — той же точке, что и раньше.
 *
 * Прежде эталон стоял «на верхнем уровне диапазона зоны»; после
 * перехода на участки это ровно верх четвёртого участка. Точка та же,
 * поэтому числа сравнимы с прежними записями, а не начинают новую
 * историю.
 *
 * Уровень врага усредняется по ВСЕМ уровням участка: внутри участка
 * он разыгрывается броском, и мерить по одному значило бы мерить
 * половину боёв. Прогоны делятся между уровнями, а не добавляются
 * к ним, — иначе секция подорожала бы вдвое-втрое без нового знания.
 */
const zoneCurve = zones.map((zone, index) => {
  const segment = zone.segments[zone.segments.length - 1];
  const playerLevel = segment.levels[1];
  const enemyLevels = [];
  for (let lv = segment.levels[0]; lv <= segment.levels[1]; lv++) enemyLevels.push(lv);
  const zonePower = segment.power;
  const levelRuns = Math.max(20, Math.round(zoneRuns / enemyLevels.length));

  /* Носитель ОДИН на все зоны и сложности — `forbidden`, самый ровный
     из четырёх. Разный носитель по зонам смешал бы трудность зоны
     с силой архетипа, а меряется здесь первое.

     ДВЕНАДЦАТЬ КОМПЛЕКТОВ: три класса оружия × четыре наклона драфта,
     и результат усредняется по всем. Причина у обеих осей одна:
     трудность зоны не должна зависеть ни от того, какое оружие выпало,
     ни от того, какой билд собрал игрок. Оружие игрок ВЫБИРАЕТ под зону
     (§4.3), билд ведёт сам (§5.2) — мерить зону одним вариантом значит
     мерить, повезло ли сегодня. Разброс по наклонам, если он велик, —
     находка о балансе школ; он печатается отдельной строкой. */
  const kitsFor = (gearSeed) =>
    ['light', 'balanced', 'heavy'].flatMap((weaponClass) =>
      LEANS.map((lean) =>
        tierGearedPlayer('forbidden', playerLevel, playerLevel, gearSeed, weaponClass, lean),
      ),
    );
  const kits = kitsFor(gearSeedTag(zone.id, 0));

  /* ВИНРЕЙТ ЗОНЫ НА ОДНОМ СИДЕ РОЛЛОВ — кирпич, из которого сложено
     всё остальное в этой секции. Сид приходит параметром, потому что
     проверяется теперь не одно число, а МЕДИАНА по девяти: сид оказался
     весомее всей нашей калибровки, и мерить им одним значило бы
     продолжать мерить удачу. */
  const rateOnSeed = (sd, power) => {
    const players = kitsFor(gearSeedTag(zone.id, sd));
    return (
      zone.monsters
        .map((key) => {
          const rates = players.flatMap((player, i) =>
            enemyLevels.map(
              (lv) =>
                duel(
                  player,
                  monsterFighter(monsterSpecs[key], lv, power),
                  `seed${sd}-${zone.id}-${key}-${i}-lv${lv}-${power.toFixed(3)}`,
                  levelRuns,
                ).rate,
            ),
          );
          return rates.reduce((a, b) => a + b, 0) / rates.length;
        })
        .reduce((a, b) => a + b, 0) / zone.monsters.length
    );
  };

  const seedRates = [];
  for (let sd = 0; sd < SEEDS; sd++) seedRates.push(rateOnSeed(sd, zonePower));
  const bySeed = seedRates.slice(1);
  const medianRate = median(seedRates);

  /* Тот же комплект, но по одному наклону: разброс между наклонами
     показывает, ровна ли колода. Считается на среднем классе оружия —
     иначе строк было бы двенадцать. */
  const byLeanOn = (sd) =>
    LEANS.map((lean) => ({
      lean,
      kit: tierGearedPlayer(
        'forbidden',
        playerLevel,
        playerLevel,
        gearSeedTag(zone.id, sd),
        'balanced',
        lean,
      ),
    }));
  const byLean = byLeanOn(0);

  const across = (spec, tag) => {
    const rates = kits.flatMap((player, i) =>
      enemyLevels.map(
        (lv) =>
          duel(player, monsterFighter(spec, lv, zonePower), `${tag}-${i}-lv${lv}`, levelRuns).rate,
      ),
    );
    return rates.reduce((a, b) => a + b, 0) / rates.length;
  };

  /** Винрейт бойца против пула зоны, усреднённый по уровням участка. */
  const versusPool = (fighter, tag) =>
    zone.monsters
      .map(
        (key) =>
          enemyLevels
            .map(
              (lv) =>
                duel(
                  fighter,
                  monsterFighter(monsterSpecs[key], lv, zonePower),
                  `${tag}-${key}-lv${lv}`,
                  levelRuns,
                ).rate,
            )
            .reduce((a, b) => a + b, 0) / enemyLevels.length,
      )
      .reduce((a, b) => a + b, 0) / zone.monsters.length;

  const perMonster = zone.monsters.map((key) => ({
    key,
    rate: across(monsterSpecs[key], `zone-${zone.id}-${key}`),
  }));

  /* ТОТ ЖЕ боец без трейтов драфта. Разделяет два рычага: сколько
     размаха дают КАРТЫ, а сколько — ШКОЛЫ ТРЕЙТОВ. Без этого деления
     правка колоды и правка школ неразличимы по результату, и чинить
     будут не то. Замерено: в Чумных ямах общий размах 64.7 п.п.,
     а на одних картах 13.3 — то есть почти весь он приходит
     от трейтов. */
  const cardsOnly = byLean.map(({ lean, kit }) => ({
    lean,
    rate: versusPool(
      { ...kit, traits: [balance.archetypes.forbidden.trait] },
      `cards-${zone.id}-${lean}`,
    ),
  }));

  const leanRates = byLean.map(({ lean, kit }) => ({
    lean,
    rate: versusPool(kit, `lean-${zone.id}-${lean}`),
  }));

  /* РАЗМАХ ПО НАКЛОНАМ ТОЖЕ МЕРИТСЯ ПО МЕДИАНЕ СИДОВ, и по той же
     причине, что кривая: на одном сиде он говорит про один комплект.
     Печатаются оба — сид 0 для сравнимости с прежними записями
     и медиана как настоящее число. */
  const spreadOn = (sd, bare) => {
    const rates = byLeanOn(sd).map(({ lean, kit }) =>
      versusPool(
        bare ? { ...kit, traits: [balance.archetypes.forbidden.trait] } : kit,
        `${bare ? 'cards' : 'lean'}-s${sd}-${zone.id}-${lean}`,
      ),
    );
    return Math.max(...rates) - Math.min(...rates);
  };
  const leanSpreadSeeds = [];
  const cardsSpreadSeeds = [];
  for (let sd = 0; sd < SEEDS; sd++) {
    leanSpreadSeeds.push(spreadOn(sd, false));
    cardsSpreadSeeds.push(spreadOn(sd, true));
  }

  const bossRate = across(monsterSpecs[zone.boss], `zone-${zone.id}-boss`);

  const rate = perMonster.reduce((sum, m) => sum + m.rate, 0) / perMonster.length;
  const target = ZONE_TARGETS[index] ?? 0;

  /* ПОДБОР ЖИВЁТ У ЛЕСТНИЦЫ, А НЕ ЗДЕСЬ. Прежде множитель подбирался
     по одной точке на зону — этой самой. Замер лестницы показал, что
     одного числа на четыре участка мало: внутри зоны трудность идёт
     не туда. Двадцать точек подбираются в секции лестницы, и четвёртый
     участок каждой зоны — одна из них, то есть эта точка тоже. Второй
     подбор здесь считал бы то же самое за ту же цену. */

  return {
    id: zone.id,
    power: zonePower,
    playerLevel,
    enemyLevels,
    rate,
    bySeed,
    seedRates,
    medianRate,
    target,
    within: Math.abs(medianRate - target) <= ZONE_ANCHOR_TOLERANCE,
    withinReference: Math.abs(rate - target) <= ZONE_TOLERANCE,
    perMonster,
    leanRates,
    cardsOnly,
    leanSpreadSeeds,
    cardsSpreadSeeds,
    medianLeanSpread: median(leanSpreadSeeds),
    medianCardsSpread: median(cardsSpreadSeeds),
    boss: bossRate,
  };
});

const zoneBreaches = zoneCurve.filter((z) => !z.within);

/* ──────────────── ЛЕСТНИЦА УЧАСТКОВ · GDD §7.4 ─────────────────
 *
 * ЗАЧЕМ ДВАДЦАТЬ ТОЧЕК, А НЕ ПЯТЬ. Кривая зон меряет по одной точке
 * на зону — четвёртый участок, — и этого хватало, пока внутри зоны
 * ничего не происходило: уровень врага там был один. Теперь внутри
 * зоны четыре ступени, и трудность на них РАЗНАЯ: кривая монстров
 * `baseStat + statPerLevel × уровень` растёт линейно, а снаряжение
 * игрока — через `1 + ilvl × ilvlScale` в каждом аффиксе. Это разные
 * наклоны, и расходятся они внутри зоны так же, как между зонами.
 * Замерять только верх зоны значило бы не видеть три ступени из
 * четырёх — ровно тот наклон, который однажды уже уехал
 * (`balance.monsters.$slope`).
 *
 * ПОЧЕМУ ШАГ МЕЖДУ УЧАСТКАМИ НЕ ПРОВЕРЯЕТСЯ ЦЕЛЬЮ. Цель кривой —
 * 10 п.п. между зонами; между участками это ~2.5 п.п., что ниже шума
 * замера (ширина 10-90 процентиля шага на 25 сидах — единицы пунктов).
 * Проверять цель на такой величине значило бы проверять шум. Поэтому
 * у лестницы проверяется только УБЫВАНИЕ, и с допуском: ступень вверх
 * означает, что участок легче предыдущего, а это перевёрнутая
 * прогрессия при любом допуске.
 *
 * ЭТАЛОН ЗДЕСЬ ДЕШЕВЛЕ, ЧЕМ У КРИВОЙ ЗОН: три класса оружия вместо
 * двенадцати комплектов. Три обязательны — с одним классом число
 * мерило бы матчап, а не трудность места. Наклоны драфта сняты:
 * их разброс меряется отдельной секцией, и платить за него
 * двадцатикратно незачем.
 */
const ladderRuns = Math.max(30, Math.round(zoneRuns / 2));

const ladder = zones.flatMap((zone) =>
  zone.segments.map((spec, segment) => {
    const [lo, hi] = spec.levels;
    const levels = [];
    for (let lv = lo; lv <= hi; lv++) levels.push(lv);

    /* Игрок берётся уровнем и снаряжением ПО УЧАСТКУ: это тот, кто
       дошёл сюда по лестнице, а не тот, кто перерос. Перерастание
       больше не помогает — в этом вся правка. */
    const kitsFor = (sd) =>
      ['light', 'balanced', 'heavy'].map((weaponClass) =>
        tierGearedPlayer(
          'forbidden',
          hi,
          hi,
          gearSeedTag(`${zone.id}-${segment}`, sd),
          weaponClass,
          'def',
        ),
      );

    const rateOnSeed = (sd, power) => {
      const players = kitsFor(sd);
      return (
        zone.monsters
          .map((key) => {
            const rates = players.flatMap((player, i) =>
              levels.map(
                (lv) =>
                  duel(
                    player,
                    monsterFighter(monsterSpecs[key], lv, power),
                    `seg${sd}-${zone.id}-${segment}-${key}-${i}-lv${lv}-${power.toFixed(3)}`,
                    ladderRuns,
                  ).rate,
              ),
            );
            return rates.reduce((a, b) => a + b, 0) / rates.length;
          })
          .reduce((a, b) => a + b, 0) / zone.monsters.length
      );
    };

    const seedRates = [];
    for (let sd = 0; sd < SEEDS; sd++) seedRates.push(rateOnSeed(sd, spec.power));

    return {
      zone: zone.id,
      segment,
      levels: spec.levels,
      power: spec.power,
      medianRate: median(seedRates),
      seedRates,
      rateOnSeed,
    };
  }),
);

/**
 * ЦЕЛЬ ЛЕСТНИЦЫ — интерполяция между якорями зон.
 *
 * Якоря те же 85/75/65/55/45 и стоят там же, где стояли: на четвёртом
 * участке каждой зоны. Между ними цель идёт линейно, а перед первым
 * якорем — от `LADDER_START`: самый первый участок обязан быть почти
 * свободным, туда приходит изгнанный с одним подобранным клинком.
 *
 * Ступень внутри зоны выходит ~2.5 п.п. Проверять её этой целью нельзя
 * (ниже шума медианы), но ПОДБИРАТЬ по ней можно и нужно: подбор
 * двигает медиану, а не попадает в неё одним сидом.
 */
const LADDER_START = 0.95;

/** Участков в зоне. Совпадает с `SEGMENTS_PER_ZONE` в shared по построению. */
const SEGMENTS_PER_ZONE = 4;

function ladderTarget(index) {
  const anchors = [{ at: -1, value: LADDER_START }];
  for (const [i, value] of ZONE_TARGETS.entries()) {
    anchors.push({ at: i * SEGMENTS_PER_ZONE + (SEGMENTS_PER_ZONE - 1), value });
  }
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1];
    const b = anchors[i];
    if (index <= b.at) {
      return a.value + ((b.value - a.value) * (index - a.at)) / (b.at - a.at);
    }
  }
  return anchors[anchors.length - 1].value;
}

/**
 * Ступени лестницы. Нарушением считается ступень ВВЕРХ: участок легче
 * предыдущего — это перевёрнутая прогрессия, и допуском она
 * не покрывается.
 *
 * Допуск нужен на шум: медиана 25 сидов имеет собственную ширину,
 * и требовать строгого убывания значило бы валить прогон на разнице
 * в один пункт, которой в игре нет.
 */
const LADDER_RISE_TOLERANCE = 0.03;

const ladderSteps = ladder.slice(1).map((point, i) => {
  const prev = ladder[i];
  const step = prev.medianRate - point.medianRate;
  return {
    from: `${prev.zone}#${prev.segment + 1}`,
    to: `${point.zone}#${point.segment + 1}`,
    step,
    /* Граница зоны — не то же самое, что ступень внутри зоны: там
       меняется и множитель силы зоны, и ожидаемый шаг вчетверо
       больше. Помечается, чтобы в выводе было видно, где что. */
    crossesZone: prev.zone !== point.zone,
    rises: step < -LADDER_RISE_TOLERANCE,
  };
});
const ladderBreaches = ladderSteps.filter((s) => s.rises);

/**
 * ПОДБОР МНОЖИТЕЛЕЙ ПО УЧАСТКАМ.
 *
 * Раньше подбирался один множитель на зону — по той точке, где кривая
 * и мерилась. Замер лестницы показал, что этого мало: внутри зоны
 * трудность идёт не туда, и одно число на четыре ступени этого
 * не выражает. Теперь подбирается двадцать чисел, по одному
 * на участок, и каждое — ПО МЕДИАНЕ сидов, как и прежде.
 *
 * Файл не трогается: числа баланса правит человек, увидев их.
 */
const ladderSuggested = CALIBRATE
  ? ladder.map((point, index) => {
      const target = ladderTarget(index);
      /* Границы поиска ШИРОКИЕ намеренно. Узкие давали бы упёршийся
         в край ответ, а он выглядит как настоящий: число печатается,
         в файл ложится, и только замер потом показывает, что цели
         оно не даёт. Упирание в край видно по повторяющемуся числу
         в столбце. */
      let lo = 0.05;
      let hi = 8;
      for (let step = 0; step < 13; step++) {
        const mid = (lo + hi) / 2;
        const probes = [];
        for (let sd = 0; sd < SEEDS; sd++) probes.push(point.rateOnSeed(sd, mid));
        if (median(probes) > target) lo = mid;
        else hi = mid;
      }
      return {
        zone: point.zone,
        segment: point.segment,
        target,
        power: Math.round(((lo + hi) / 2) * 100) / 100,
      };
    })
  : null;

/* ──────────── ТУПИК НЕВОСПРОИЗВОДИМ · PLAYTEST 2026-09-04 ────────────
 *
 * Главная проверка этой правки, и она отвечает не на «сбалансировано
 * ли», а на «есть ли выход». Прежде уровень врага считался как
 * `clamp(уровень игрока + сдвиг, мин зоны, макс зоны)`: игрок рос, зона
 * росла с ним, а снаряжение оставалось того уровня, на котором добыто.
 * Игрок в эпиках ilvl 2 к шестому уровню не мог пройти первую зону
 * и не мог добыть ничего лучше — выхода средствами игры не было.
 *
 * СВОЙСТВО, КОТОРОЕ ОБЯЗАНО ДЕРЖАТЬСЯ: пройденный участок остаётся
 * проходимым НАВСЕГДА. Формально — винрейт на участке не падает
 * с ростом уровня игрока. Меряется на первом участке первой зоны:
 * он и есть то место, куда игрок возвращается.
 *
 * ЭТО ТЕСТ НА ОТСУТСТВИЕ ПЛОХОГО ПОВЕДЕНИЯ, поэтому рядом стоит пара:
 * уровень игрока в выборке обязан РЕАЛЬНО меняться и что-то менять,
 * иначе «не падает» верно и для замера, который меряет одно и то же
 * число четыре раза.
 */
const DEADLOCK_LEVELS = [2, 6, 12, 24, 40];
const deadlockZone = zones[0];
const deadlockSegment = 0;

const deadlock = DEADLOCK_LEVELS.map((level) => {
  const {
    levels: [lo, hi],
    power: deadlockPower,
  } = deadlockZone.segments[deadlockSegment];
  const levels = [];
  for (let lv = lo; lv <= hi; lv++) levels.push(lv);

  const rateOnSeed = (sd) => {
    const players = ['light', 'balanced', 'heavy'].map((weaponClass) =>
      /* Снаряжение ПО УРОВНЮ ИГРОКА, а не по участку: моделируется
         тот, кто вырос и вернулся. Именно он и упирался в тупик. */
      tierGearedPlayer(
        'forbidden',
        level,
        level,
        gearSeedTag(`dead-${level}`, sd),
        weaponClass,
        'def',
      ),
    );
    return (
      deadlockZone.monsters
        .map((key) => {
          const rates = players.flatMap((player, i) =>
            levels.map(
              (lv) =>
                duel(
                  player,
                  monsterFighter(monsterSpecs[key], lv, deadlockPower),
                  `dead-${level}-s${sd}-${key}-${i}-lv${lv}`,
                  ladderRuns,
                ).rate,
            ),
          );
          return rates.reduce((a, b) => a + b, 0) / rates.length;
        })
        .reduce((a, b) => a + b, 0) / deadlockZone.monsters.length
    );
  };

  const seedRates = [];
  for (let sd = 0; sd < SEEDS; sd++) seedRates.push(rateOnSeed(sd));
  return { level, medianRate: median(seedRates) };
});

/* Допуск на шум медианы: падение в пределах него — не тупик,
   а разброс замера. Настоящий тупик выглядел иначе — десятки пунктов. */
const DEADLOCK_TOLERANCE = 0.05;

const deadlockBreaches = deadlock.slice(1).filter((point, i) => {
  const prev = deadlock[i];
  return point.medianRate < prev.medianRate - DEADLOCK_TOLERANCE;
});

/* ПАРА К ПРОВЕРКЕ ВЫШЕ. «Не падает» верно и для замера, где уровень
   игрока не меняет вообще ничего, — а именно так выглядела бы
   поломка, вернувшая уровень игрока в расчёт врага наоборот.
   Рост обязан быть виден. */
const deadlockFlat =
  deadlock[deadlock.length - 1].medianRate - deadlock[0].medianRate < DEADLOCK_TOLERANCE;

/**
 * ФОРМА КРИВОЙ — шаги между соседними зонами, по медиане сидов.
 *
 * Это и есть проверяемая величина: она устойчива к сиду роллов,
 * а абсолютная высота — нет. Нарушением считается либо шаг вне допуска,
 * либо шаг вверх (зона легче предыдущей): второе — не «форма чуть
 * поехала», а перевёрнутая прогрессия, и допуском оно не покрывается.
 */
const zoneSteps = zoneCurve.slice(1).map((z, i) => {
  const prev = zoneCurve[i];
  const step = prev.medianRate - z.medianRate;
  return {
    from: prev.id,
    to: z.id,
    step,
    within: Math.abs(step - ZONE_STEP) <= ZONE_STEP_TOLERANCE,
    /* Убывание проверяется ОТДЕЛЬНО от допуска. Шаг −0.02 при допуске
       0.05 формально «в пределах», но означает, что четвёртая зона
       легче третьей, — а это ровно то, чего кривая зон не должна
       допускать ни при каком допуске. */
    descends: step > 0,
  };
});
const stepBreaches = zoneSteps.filter((s) => !s.within || !s.descends);

/**
 * ЦЕЛЬ по разбросу наклонов, и это ЦЕЛЬ, а не порог.
 *
 * Драфт обещает направленный билд (§5.2). Обещание не означает, что
 * один наклон обязан проходить зону, а другой — нет: тогда «выбери,
 * во что вырос» превращается в «угадай единственный работающий путь»,
 * то есть ровно в тот выбор без выбора, от которого 2.0 избавляется.
 *
 * Двадцать пунктов назначены, а не выведены: чем измеряется «школы
 * значат что-то, но не всё», документ не говорит. Число помечено
 * pending вместе с остальной калибровкой драфта.
 *
 * Прогон это НЕ ВАЛИТ. Величина новая, замерена впервые, и ронять
 * на ней сборку значило бы держать её красной на вопросе, ответ
 * на который принимает человек. Печатается — громко.
 */
const LEAN_SPREAD_GOAL = 0.2;
/* Размах берётся ПО МЕДИАНЕ СИДОВ, как и кривая. На одном сиде это
   число говорит про один комплект: сид роллов весит здесь столько же,
   сколько в кривой зон, и «размах в цели» на сиде 0 могло означать
   ровно то же, чем оказались абсолютные винрейты. */
const leanSpread = zoneCurve.map((z) => ({ id: z.id, spread: z.medianLeanSpread }));
const leanSpreadWorst = leanSpread.reduce((a, b) => (b.spread > a.spread ? b : a));

/* ─────────────────── ДОХОДИМОСТЬ ЗАБЕГА · GDD §7.2 ───────────────────
 *
 * Кривая зон меряет ОДИН бой при равном снаряжении. Забег — другая
 * величина, и одна из первой не выводится: HP переносится между боями,
 * поэтому пять боёв по 85% дают вовсе не 0.85⁵, а заметно меньше —
 * победа с четвертью запаса делает следующий бой не 85-процентным.
 *
 * Меряется то, ради чего рейд написан: доходит ли новый игрок
 * до РЕШЕНИЯ. Решений три (после боёв 2, 3 и 4, §7.2); не увидев
 * ни одного, игрок не увидел центральной механики игры.
 *
 * Боец — НАСТОЯЩИЙ СВЕЖИЙ ИЗГНАННИК: статы архетипа первого уровня,
 * из снаряжения один обычный меч первого уровня, ровно то, что выдаёт
 * `grantStartingWeapon`. Не «эталон в тир-комплекте»: комплекта у него
 * нет и взяться ему неоткуда, а мерить первую сессию на снаряжённом
 * бойце значит мерить не первую сессию.
 */
const { maxHp: maxHpOf } = await import(fileURLToPath(new URL('packages/sim/dist/index.js', root)));

const STARTING_WEAPON = 'weapon.sword';

function freshExile(archetype) {
  const a = balance.archetypes[archetype];
  const base = itemBases[STARTING_WEAPON];
  const gear = 1 + 1 * balance.items.ilvlScale;

  return {
    level: 1,
    atk: a.atk,
    def: a.def,
    agi: a.agi,
    spd: a.spd,
    pathBonusHp: 0,
    gearBonusHp: 0,
    /* БАЗА АРХЕТИПА, а не ноль. До починки эти два числа не применялись
       к игроку нигде — их читала только матрица, собирая бойцов
       для коридора. То есть коридор был выверен на конфигурации,
       которой игра не производила, а свежий изгнанный входил в зону
       голым. Здесь он теперь такой же, как в игре. */
    accuracy: a.accuracy,
    armor: a.armor,
    armorClass: 'medium',
    critBonus: 0,
    startHp: null,
    // Обычная редкость — ноль аффиксов (§6.2). Первый лут обязан
    // быть шагом вперёд, а не догоняющим.
    weapon: {
      dmgMin: base.dmgMin * gear,
      dmgMax: base.dmgMax * gear,
      ilvl: 1,
      class: base.weaponClass,
    },
    offhand: null,
    percentAffixes: { might: [], bastion: [], swiftness: [] },
    accuracyAffixes: [],
    statuses: [],
    traits: [a.trait],
  };
}

/** Доля максимума, возвращаемая между боями. Зона может её переопределить. */
function restoreFractionOf(zone) {
  return zone.hpRestoreBetweenFights ?? balance.raid.hpRestoreBetweenFights;
}

/**
 * Один забег до конца или до смерти. Повторяет server/src/runs/service.ts.
 *
 * `withPotions` — не «читерский режим», а вторая честная величина:
 * без зелий меряется САМА настройка, с зельями — то, что увидит игрок,
 * который ими пользуется. Числа расходятся, и показывать одно значило бы
 * выбрать за человека, какой вопрос он задал.
 */
function simulateRun(player, zone, segment, seedTag, withPotions) {
  const maxHp = maxHpOf(player, balance);
  const restore = restoreFractionOf(zone);
  const spec = zone.segments[segment];
  const bounds = spec.levels;

  let hp = maxHp;
  let potions = withPotions ? balance.raid.potionChargesPerRun : 0;
  let cleared = 0;

  for (let fight = 0; fight < balance.raid.fightsPerRun; fight++) {
    /* Зелье пьётся МЕЖДУ боями, и политика здесь простейшая: ниже
       половины запаса — пить. Сложная политика мерила бы мастерство
       игрока, а не настройку. */
    if (potions > 0 && hp < maxHp * (1 - balance.raid.potionHealFraction)) {
      hp = Math.min(maxHp, Math.round(hp + maxHp * balance.raid.potionHealFraction));
      potions--;
    }

    /* ПРОТИВНИК ВЫБИРАЕТСЯ ТАК ЖЕ, КАК В ИГРЕ, а не по кругу.
       Прежде здесь стояло `fight % pool.length` — ровный перебор,
       который ГАРАНТИРОВАЛ встречу с каждым монстром зоны, включая
       худший матчап. Игра бросает, и бросок иногда даёт пройти мимо:
       при трёх монстрах и четырёх боях шанс не встретить конкретного —
       (2/3)^4 ≈ 20%. То есть модель была строже игры, и разойтись они
       могли ровно на эту величину.

       Сама формула — `seededRoll` из shared, та же, что у сервера.
       Повторить её здесь третьей копией значило бы завести ту самую
       ошибку, из-за которой этот комментарий и написан. */
    const last = fight === balance.raid.fightsPerRun - 1;
    const pool = zone.monsters;
    const at = Math.min(
      pool.length - 1,
      Math.floor(seededRoll(`${seedTag}:enemy:${fight}`) * pool.length),
    );
    const who = last ? monsterSpecs[zone.boss] : monsterSpecs[pool[at]];

    /* УРОВЕНЬ ТОЖЕ БРОСАЕТСЯ, и СВОИМ броском, как на сервере: один
       бросок на «кто вышел» и «какого он уровня» связал бы их, и часть
       монстров встречалась бы только на своём конце диапазона. Босс
       берёт верхнюю границу участка. */
    const [lo, hi] = bounds;
    const level = last
      ? hi
      : Math.min(hi, lo + Math.floor(seededRoll(`${seedTag}:level:${fight}`) * (hi - lo + 1)));

    const { outcome } = resolveBattle(
      [{ ...player, startHp: hp }, monsterFighter(who, level, spec.power)],
      balance,
      `${seedTag}-f${fight}`,
    );

    if (outcome.winner !== 0) return cleared;
    cleared++;
    hp = Math.min(maxHp, Math.max(1, Math.round(outcome.hpRemaining[0] + maxHp * restore)));
  }

  return cleared;
}

/**
 * Доходимость меряется на ПЕРВОМ УЧАСТКЕ первой зоны: первая сессия
 * идёт туда, и туда же теперь пускают — уровень игрока доступа
 * не открывает, открывает прохождение.
 */
const REACH_ZONE = zones[0];

/**
 * ЦЕЛЬ дизайна и ПОРОГ проверки — разные числа, и их нельзя путать.
 *
 * Цель: до первого решения доходит больше половины забегов. Она
 * НЕ ДОСТИГНУТА и рычагом восстановления недостижима — замерено:
 * даже при полном исцелении между боями (доля 1.0, потолок рычага)
 * выходит 35%, потому что связывает не перенос HP, а винрейт свежего
 * изгнанного в ОДНОМ бою при полном запасе: у него ноль брони, вся
 * броня в игре приходит с предметов.
 *
 * Порог: то, что достигнуто сейчас, минус запас на шум. Он сторожит
 * РЕГРЕССИЮ, а не подтверждает цель. Ставить порогом цель значило бы
 * держать сборку красной на известном и вынесенном человеку вопросе;
 * молча опустить цель до порога — выдать недостигнутое за достигнутое.
 * Поэтому печатаются оба.
 */
const REACH_TARGET = 0.5;
const REACH_FLOOR = 0.08;
const reachRuns = Math.max(200, Math.round(RUNS / 10));

const reach = ARCHETYPES.map((archetype) => {
  const player = freshExile(archetype);
  const tally = (withPotions) => {
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < reachRuns; i++) {
      counts[simulateRun(player, REACH_ZONE, 0, `reach-${archetype}-${i}`, withPotions)]++;
    }
    // Доля забегов, в которых пройдено НЕ МЕНЬШЕ n боёв.
    const atLeast = (n) => counts.slice(n).reduce((a, b) => a + b, 0) / reachRuns;
    return { first: atLeast(2), second: atLeast(3), third: atLeast(4), full: atLeast(5) };
  };
  return { archetype, dry: tally(false), potions: tally(true) };
});

const reachAvg = (key, mode) => reach.reduce((sum, r) => sum + r[mode][key], 0) / reach.length;

/* ─────────────── ДОХОДИМОСТЬ НА РАЗНЫХ УРОВНЯХ · §7.2 ────────────────
 *
 * Замер выше отвечает на один вопрос: «доживает ли ПЕРВАЯ сессия
 * до решения». Он про свежего изгнанного и про первую зону, и другого
 * вопроса не задаёт.
 *
 * Этот отвечает на второй: держится ли ставка ДАЛЬШЕ. Игрок растёт,
 * зоны растут вместе с ним, и «забег остаётся риском» — утверждение
 * про всю игру, а не про первый час. Вывести одно из другого нельзя:
 * на десятом уровне у игрока снаряжение, две-три карты и трейт,
 * а зона другая.
 *
 * ОСНОВАНИЕ РАЗНОЕ, и оно названо в выводе. На первом уровне игрок
 * гол — комплекта у него нет и взяться неоткуда. На десятом и двадцатом
 * он в эпическом комплекте своего уровня: это тот же эталон, на котором
 * меряется кривая зон, и брать здесь другого значило бы получить два
 * несравнимых числа.
 */
const REACH_LEVELS = [1, 10, 20];

/**
 * УЧАСТОК, СООТВЕТСТВУЮЩИЙ УРОВНЮ ИГРОКА.
 *
 * Прежде здесь была зона: доходимость мерилась «игрок уровня L в зоне,
 * куда его пускают». Зон пять, участков двадцать, и вопрос теперь
 * точнее — какой участок игрок этого уровня способен пройти. Берётся
 * первый, чей верх не ниже уровня: это и есть место, куда он дошёл бы,
 * двигаясь по лестнице.
 */
const segmentForLevel = (level) => {
  for (const zone of zones) {
    for (let i = 0; i < zone.segments.length; i++) {
      if (level <= zone.segments[i].levels[1]) return { zone, segment: i };
    }
  }
  const last = zones[zones.length - 1];
  return { zone: last, segment: last.segments.length - 1 };
};

const reachByLevel = REACH_LEVELS.map((level) => {
  const { zone, segment } = segmentForLevel(level);
  // На первом уровне усредняем по архетипам, дальше — по наклонам
  // драфта: с уровня выбор игрока начинает значить больше, чем причина
  // изгнания.
  /* СИД РОЛЛОВ ЗДЕСЬ ТОЖЕ ВЕСИТ, и по той же причине, что в кривой зон:
     с первого уровня начинается снаряжение, а оно роллится. Поэтому
     доходимость выше первого уровня считается по нескольким сидам
     и сворачивается МЕДИАНОЙ.

     ПЕРВЫЙ УРОВЕНЬ ОТ СИДА НЕ ЗАВИСИТ ВООБЩЕ — и это конструкция,
     а не удача: `freshExile` гол, роллов у него нет. Гонять его
     по девяти сидам значило бы девять раз посчитать одно и то же. */
  const playersOn = (sd) =>
    level === 1
      ? ARCHETYPES.map((a) => freshExile(a))
      : LEANS.map((lean) =>
          tierGearedPlayer('forbidden', level, level, `reach-${level}-s${sd}`, 'balanced', lean),
        );
  const seedCount = level === 1 ? 1 : SEEDS;

  const tallyOn = (sd, withPotions) => {
    const players = playersOn(sd);
    const totals = { first: 0, second: 0, third: 0, full: 0 };
    for (const [n, player] of players.entries()) {
      const counts = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < reachRuns; i++) {
        counts[
          simulateRun(player, zone, segment, `reachlv-${level}-s${sd}-${n}-${i}`, withPotions)
        ]++;
      }
      const atLeast = (k) => counts.slice(k).reduce((a, b) => a + b, 0) / reachRuns;
      totals.first += atLeast(2) / players.length;
      totals.second += atLeast(3) / players.length;
      totals.third += atLeast(4) / players.length;
      totals.full += atLeast(5) / players.length;
    }
    return totals;
  };

  const tally = (withPotions) => {
    const runs = [];
    for (let sd = 0; sd < seedCount; sd++) runs.push(tallyOn(sd, withPotions));
    const at = (key) => median(runs.map((r) => r[key]));
    return {
      first: at('first'),
      second: at('second'),
      third: at('third'),
      full: at('full'),
      firstSeeds: runs.map((r) => r.first),
    };
  };

  return {
    level,
    zone: zone.id,
    basis: level === 1 ? 'голый новичок' : 'эпический комплект',
    dry: tally(false),
    potions: tally(true),
  };
});

/* Порог стоит на ПЕРВОМ решении и на замере БЕЗ зелий. Первое решение —
   потому что не увидев ни одного, игрок не увидел механики вовсе.
   Без зелий — потому что зелья это выбор игрока, а порог обязан мерить
   настройку, а не то, догадался ли он пить. */
const reachBreached = reachAvg('first', 'dry') < REACH_FLOOR;
const reachShort = reachAvg('first', 'dry') < REACH_TARGET;

/* ─────────────────────────────── вывод ──────────────────────────────── */

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const breaches = pairs.filter((p) => p.rate < LOW || p.rate > HIGH);

const report = () => ({
  runs: RUNS,
  seeds: SEEDS,
  corridor: [LOW, HIGH],
  pairs,
  combos,
  solo,
  budgetProbe,
  zoneCurve,
  zoneSteps,
  reach,
  breaches,
  breachesShape: stepBreaches,
  ladder,
  ladderSteps,
  breachesLadder: ladderBreaches,
  deadlock,
  breachesDeadlock: deadlockBreaches,
  zoneBreaches,
});

if (AS_JSON) {
  console.log(JSON.stringify(report(), null, 2));
} else {
  if (JSON_OUT !== null) writeFileSync(JSON_OUT, JSON.stringify(report(), null, 2));
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

  console.log(`\nБЮДЖЕТЫ ПРОЦЕНТНЫХ СЕМЕЙСТВ · §6.1, проверка расчёта замером`);
  console.log(`Носитель N аффиксов T1 против носителя N аффиксов T5.`);
  console.log(`Уровень и ilvl носителей: ${BUDGET_LEVEL} — там, где T1 выпадает.`);
  console.log(`Прогонов на пару: ${budgetRuns}.\n`);
  console.log(
    `${pad('семейство', 12)}${pad('аффиксов', 10)}${pad('режим', 14)}${padL('множитель', 11)}${padL('винрейт', 9)}`,
  );
  console.log('─'.repeat(68));
  let lastFamily = null;
  for (const probe of budgetProbe) {
    if (lastFamily !== null && probe.family !== lastFamily) console.log('');
    lastFamily = probe.family;
    console.log(
      pad(probe.family, 12) +
        pad(probe.count, 10) +
        pad(probe.mode, 14) +
        padL(`×${probe.ratio.toFixed(3)}`, 11) +
        padL(pct(probe.rate), 9),
    );
  }
  console.log('');
  console.log('GDD §6.1 назначил бюджет «Мощи» РАСЧЁТОМ: «четыре T1 против четырёх');
  console.log('T5 дают ×1.5 урона», «при двух — ×1.23, около 82%». Строки');
  console.log('«без бюджета» проверяют первое утверждение, строки «с бюджетом» —');
  console.log('что ограничение действительно держит: при четырёх аффиксах оно');
  console.log('обязано давать то же, что при двух. Для «Оплота» и «Проворства»');
  console.log('числа бюджета назначены по аналогии и проверяются здесь же.');

  console.log(`\nКРИВАЯ ЗОН · §4.6, пункт 4`);
  console.log('Игрок в полном эпическом комплекте на верхнем уровне зоны,');
  console.log('с настоящей прогрессией §5.2: автоприрост, карты из офферов,');
  console.log('трейты пятых уровней. Усреднение по трём классам оружия');
  console.log('и четырём наклонам драфта.');
  console.log(`Нормальная сложность, ${zoneRuns} боёв на монстра, ${SEEDS} сид(ов) роллов.`);
  console.log('');
  console.log('ПРОВЕРЯЕТСЯ ФОРМА, А НЕ ВЫСОТА: шаг между соседними зонами');
  console.log(
    `по МЕДИАНЕ сидов, цель ${(ZONE_STEP * 100).toFixed(0)} п.п., допуск ±${(ZONE_STEP_TOLERANCE * 100).toFixed(0)}.`,
  );
  console.log('Абсолютные числа остались ориентиром и печатаются, но прогон');
  console.log(
    `ими не валится — высота сторожится грубым якорем ±${(ZONE_ANCHOR_TOLERANCE * 100).toFixed(0)} п.п.`,
  );
  console.log('');
  console.log(
    `${pad('зона', 12)}${padL('ур.', 8)}${padL('power', 8)}${padL('медиана', 9)}${padL('шаг', 8)}${padL('сид 0', 8)}${padL('ориентир', 10)}${padL('босс', 8)}   по монстрам`,
  );
  console.log('─'.repeat(86));
  for (const [i, z] of zoneCurve.entries()) {
    const st = i === 0 ? null : zoneSteps[i - 1];
    console.log(
      pad(z.id, 12) +
        padL(`${z.playerLevel}/${z.enemyLevels[0]}-${z.enemyLevels[z.enemyLevels.length - 1]}`, 8) +
        padL(z.power.toFixed(2), 8) +
        padL(pct(z.medianRate), 9) +
        padL(st === null ? '—' : `${(st.step * 100).toFixed(1)}`, 8) +
        padL(pct(z.rate), 8) +
        padL(pct(z.target), 10) +
        padL(pct(z.boss), 8) +
        '   ' +
        z.perMonster.map((m) => `${m.key.split('.')[1]} ${pct(m.rate)}`).join(' · '),
    );
  }
  console.log('');

  /* РАЗБРОС ПО СИДАМ РОЛЛОВ. Отвечает на вопрос, которого мы себе
     до сих пор не задавали: насколько цель 85/75/65/55/45 — свойство
     настройки, а насколько свойство одного зафиксированного сида
     снаряжения. Пока сид один, отличить нельзя в принципе.

     Цель у этой секции ОДНА — показать число. Она ничего не валит
     и ничего не подгоняет: если разброс велик, вывод не «поднять
     допуск», а «целями должны стать разницы, а не абсолютные числа»,
     и это решение человека, а не скрипта. */
  if (SEEDS > 1) {
    console.log(`РАЗБРОС ПО СИДАМ РОЛЛОВ СНАРЯЖЕНИЯ · ${SEEDS} сид(ов)`);
    console.log(
      pad('зона', 12) +
        padL('цель', 8) +
        padL('сид 0', 9) +
        padL('мин', 9) +
        padL('макс', 9) +
        padL('размах', 9) +
        padL('медиана', 10) +
        padL('мед−сид 0', 14),
    );
    console.log('─'.repeat(86));
    for (const z of zoneCurve) {
      const all = z.seedRates;
      const lo = Math.min(...all);
      const hi = Math.max(...all);
      console.log(
        pad(z.id, 12) +
          padL(pct(z.target), 8) +
          padL(pct(z.rate), 9) +
          padL(pct(lo), 9) +
          padL(pct(hi), 9) +
          padL(`${((hi - lo) * 100).toFixed(1)} п.п.`, 9) +
          padL(pct(z.medianRate), 10) +
          padL(`${((z.medianRate - z.rate) * 100).toFixed(1)} п.п.`, 14),
      );
    }
    console.log('');
    console.log('Сид 0 — исторический, на нём кривая калибровалась до перехода');
    console.log('к медиане. «Медиана−сид 0» показывает, насколько он смещён:');
    console.log('это и есть цена прежней калибровки по одному сиду.');
    console.log('');
  }

  /* РАЗБРОС ПО НАКЛОНАМ. Печатается отдельно от усреднённой кривой,
     потому что отвечает на другой вопрос: ровна ли колода. Большая
     разница между наклонами означает, что трудность зоны для игрока
     зависит от того, какой билд он собрал, — а это уже не про зону. */
  console.log(`РАЗБРОС ПО НАКЛОНАМ ДРАФТА (среднее оружие, без босса, ${SEEDS} сид(ов))`);
  console.log('Винрейты по наклонам — на сиде 0; размах — МЕДИАНА по сидам.');
  console.log(
    pad('зона', 12) +
      LEANS.map((l) => padL(l, 8)).join('') +
      padL('размах', 9) +
      padL('на сиде 0', 11) +
      padL('без трейтов', 13),
  );
  console.log('─'.repeat(86));
  for (const z of zoneCurve) {
    console.log(
      pad(z.id, 12) +
        z.leanRates.map((r) => padL(pct(r.rate), 8)).join('') +
        padL(pct(z.medianLeanSpread), 9) +
        padL(pct(z.leanSpreadSeeds[0]), 11) +
        padL(pct(z.medianCardsSpread), 13),
    );
  }
  console.log('');
  console.log(`ЦЕЛЬ по размаху ${pct(LEAN_SPREAD_GOAL)} — прогон этим не валится.`);
  if (leanSpreadWorst.spread > LEAN_SPREAD_GOAL) {
    console.log(
      `РАЗМАХ ВЫШЕ ЦЕЛИ: ${leanSpreadWorst.id}, ${pct(leanSpreadWorst.spread)}. Это значит,`,
    );
    console.log('что трудность зоны определяется выбранным билдом сильнее, чем самой');
    console.log('зоной. Множитель зоны тут не поможет: он двигает все наклоны разом.');
    console.log('Колонка «без трейтов» говорит, КУДА смотреть: если она заметно');
    console.log('меньше общего размаха, дело в школах трейтов, а не в колоде.');
  }
  console.log('');
  console.log('');
  console.log('ДОХОДИМОСТЬ ЗАБЕГА · §7.2, первая зона, нормальная сложность');
  console.log('Свежий изгнанный: статы архетипа, один обычный меч, больше ничего.');
  console.log(
    `Восстановление между боями: ${(restoreFractionOf(REACH_ZONE) * 100).toFixed(0)}% максимума.`,
  );
  console.log('');
  console.log(
    pad('архетип', 12) +
      padL('решение 1', 11) +
      padL('решение 2', 11) +
      padL('решение 3', 11) +
      padL('весь забег', 12) +
      '   (без зелий / с зельями)',
  );
  console.log('─'.repeat(86));
  for (const r of reach) {
    console.log(
      pad(r.archetype, 12) +
        padL(`${pct(r.dry.first)}/${pct(r.potions.first)}`, 11) +
        padL(`${pct(r.dry.second)}/${pct(r.potions.second)}`, 11) +
        padL(`${pct(r.dry.third)}/${pct(r.potions.third)}`, 11) +
        padL(`${pct(r.dry.full)}/${pct(r.potions.full)}`, 12),
    );
  }
  console.log('─'.repeat(86));
  console.log(
    pad('в среднем', 12) +
      padL(`${pct(reachAvg('first', 'dry'))}/${pct(reachAvg('first', 'potions'))}`, 11) +
      padL(`${pct(reachAvg('second', 'dry'))}/${pct(reachAvg('second', 'potions'))}`, 11) +
      padL(`${pct(reachAvg('third', 'dry'))}/${pct(reachAvg('third', 'potions'))}`, 11) +
      padL(`${pct(reachAvg('full', 'dry'))}/${pct(reachAvg('full', 'potions'))}`, 12),
  );
  console.log('');
  console.log('');
  console.log('ДОХОДИМОСТЬ ПО УРОВНЯМ · §7.2, зона по уровню, нормальная сложность');
  console.log('Первый уровень — голый новичок; дальше эпический комплект своего');
  console.log('уровня, усреднение по четырём наклонам драфта.');
  console.log(`Числа — МЕДИАНА по ${SEEDS} сидам роллов; на первом уровне роллов нет.`);
  console.log('');
  console.log(
    pad('уровень', 9) +
      pad('зона', 12) +
      pad('основание', 20) +
      padL('решение 1', 11) +
      padL('решение 2', 11) +
      padL('весь забег', 12) +
      padL('размах реш. 1', 15) +
      '   (без зелий / с зельями)',
  );
  console.log('─'.repeat(86));
  for (const r of reachByLevel) {
    const seeds = r.dry.firstSeeds;
    const span = seeds.length > 1 ? Math.max(...seeds) - Math.min(...seeds) : 0;
    console.log(
      pad(r.level, 9) +
        pad(r.zone, 12) +
        pad(r.basis, 20) +
        padL(`${pct(r.dry.first)}/${pct(r.potions.first)}`, 11) +
        padL(`${pct(r.dry.second)}/${pct(r.potions.second)}`, 11) +
        padL(`${pct(r.dry.full)}/${pct(r.potions.full)}`, 12) +
        padL(seeds.length > 1 ? `${(span * 100).toFixed(1)} п.п.` : 'роллов нет', 15),
    );
  }
  console.log('');
  console.log(`ЦЕЛЬ ${pct(REACH_TARGET)} до первого решения · ПОРОГ ПРОВЕРКИ ${pct(REACH_FLOOR)}`);
  console.log('Оба берутся без зелий: зелья — выбор игрока, а число обязано');
  console.log('мерить настройку, а не догадливость.');
  if (reachShort) {
    console.log('');
    console.log(
      `ЦЕЛЬ НЕ ДОСТИГНУТА: ${pct(reachAvg('first', 'dry'))} против ${pct(REACH_TARGET)}.`,
    );
  }
  if (reachBreached) {
    console.log('');
    console.log(
      `ДОХОДИМОСТЬ УПАЛА НИЖЕ ПОРОГА: ${pct(reachAvg('first', 'dry'))} против ${pct(REACH_FLOOR)}.`,
    );
    console.log('Это РЕГРЕССИЯ. Смотреть надо в таком порядке:');
    console.log('  1. применяется ли игроку базовая броня архетипа (players.base_armor);');
    console.log('  2. наклон кривой монстров — monsters.baseStat и armorBase;');
    console.log('  3. множитель силы первой зоны.');
  }
  console.log('');
  console.log('Босс считается ОТДЕЛЬНО и в кривую не входит: он пятый бой,');
  console.log('а не типичный противник зоны. Смешать их значило бы занижать');
  console.log('оценку первых четырёх боёв.');

  if (CALIBRATE && ladderSuggested !== null) {
    console.log('ПОДБОР МНОЖИТЕЛЕЙ ПО УЧАСТКАМ (файл не тронут — правит человек):');
    for (const p of ladderSuggested) {
      console.log(
        `  ${pad(`${p.zone} #${p.segment + 1}`, 18)} power ${String(p.power).padStart(5)}` +
          `   цель ${pct(p.target)}`,
      );
    }
    console.log('');
  }

  if (stepBreaches.length > 0) {
    console.log(`\nФОРМА КРИВОЙ НАРУШЕНА в ${stepBreaches.length} шаг(ах):`);
    for (const st of stepBreaches) {
      const why = !st.descends ? 'зона НЕ ТРУДНЕЕ предыдущей' : 'шаг вне допуска';
      console.log(
        `  ${st.from} → ${st.to}: ${(st.step * 100).toFixed(1)} п.п. ` +
          `против ${(ZONE_STEP * 100).toFixed(0)} — ${why}`,
      );
    }
    console.log('Править надо power в zones.json, и подбирать ПО МЕДИАНЕ:');
    console.log('`--calibrate` теперь ищет её, а не попадание одного сида.');
  }

  /* ЛЕСТНИЦА УЧАСТКОВ — двадцать точек вместо пяти. Кривая зон меряет
     четвёртый участок каждой зоны; здесь видно, что происходит внутри,
     а внутри теперь происходит: уровень врага растёт по ступеням. */
  console.log('\nЛЕСТНИЦА УЧАСТКОВ · медиана по сидам, ступень к предыдущему');
  console.log('─'.repeat(66));
  console.log(
    `${pad('участок', 18)}${padL('уровни', 9)}${padL('медиана', 10)}${padL('ступень', 10)}`,
  );
  for (const [i, point] of ladder.entries()) {
    const st = i === 0 ? null : ladderSteps[i - 1];
    const mark = st === null ? '' : st.crossesZone ? '  ← граница зоны' : '';
    console.log(
      pad(`${point.zone} #${point.segment + 1}`, 18) +
        padL(`${point.levels[0]}-${point.levels[1]}`, 9) +
        padL(pct(point.medianRate), 10) +
        padL(st === null ? '—' : `${(st.step * 100).toFixed(1)}`, 10) +
        mark,
    );
  }

  /* ТУПИК: пройденный участок обязан остаться проходимым навсегда. */
  console.log('\nТУПИК НЕВОСПРОИЗВОДИМ · первый участок Пустошей, игрок разных уровней');
  console.log('─'.repeat(66));
  console.log('  ' + deadlock.map((d) => `ур.${d.level} ${pct(d.medianRate)}`).join(' · '));
  if (deadlockBreaches.length > 0) {
    console.log('ТУПИК ВЕРНУЛСЯ: с ростом уровня участок стал ТРУДНЕЕ.');
    for (const d of deadlockBreaches) console.log(`  на ур. ${d.level}: ${pct(d.medianRate)}`);
  } else if (deadlockFlat) {
    console.log('ЗАМЕР НИЧЕГО НЕ МЕРИТ: уровень игрока не меняет исход вовсе.');
  } else {
    console.log('Участок остаётся проходимым: с ростом уровня только легче.');
  }

  if (ladderBreaches.length > 0) {
    console.log(`\nЛЕСТНИЦА ИДЁТ ВВЕРХ в ${ladderBreaches.length} ступен(ях):`);
    for (const st of ladderBreaches) {
      console.log(
        `  ${st.from} → ${st.to}: ${(st.step * 100).toFixed(1)} п.п. — участок ЛЕГЧЕ предыдущего`,
      );
    }
    console.log('Цель 10 п.п. здесь не проверяется: между участками это ~2.5,');
    console.log('то есть ниже шума замера. Проверяется только убывание.');
  }

  if (zoneBreaches.length > 0) {
    console.log(`\nВЫСОТА КРИВОЙ УШЛА в ${zoneBreaches.length} зон(ах):`);
    for (const z of zoneBreaches) {
      console.log(`  ${z.id}: медиана ${pct(z.medianRate)} против ориентира ${pct(z.target)}`);
    }
    console.log('Форма может быть верной на кривой, где играть невозможно');
    console.log('нигде, — поэтому якорь тоже проверяется, пусть и грубо.');
  }
  console.log('');

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

/* Красным считается коридор архетипов, ФОРМА кривой зон, её высота
   по грубому якорю и доходимость.

   Кривая добавлена в M3b: пункт 4 §4.6 перестал быть «не проверяется»,
   а проверка, которая печатает число и не роняет сборку, — это
   комментарий, а не проверка. Форма пришла на место абсолютных чисел
   позже: те мерили сид роллов наравне с настройкой, и держать их
   красной линией значило бы валить сборку за удачу. */
process.exit(
  breaches.length > 0 ||
    stepBreaches.length > 0 ||
    zoneBreaches.length > 0 ||
    ladderBreaches.length > 0 ||
    deadlockBreaches.length > 0 ||
    deadlockFlat ||
    reachBreached
    ? 1
    : 0,
);
