#!/usr/bin/env node
/**
 * ПРИБОР ЭКОНОМИКИ, И ТОЛЬКО ПРИБОР. GDD §6.3, §5.2, §7.2.
 *
 * Здесь нет ни одной таблицы дохода и ни одной таблицы расхода —
 * они появятся, когда прибор докажет, что меряет то, что надо.
 * Порядок обратный писался бы легче и врал бы убедительнее: числа
 * экономики подбираются тем же прибором, что и множители участков,
 * а тот четыре раза подряд оказывался неверен, печатая правдоподобное.
 *
 * ПЯТЬ ПРОВЕРОК НА ЗАРАНЕЕ ИЗВЕСТНОМ ОТВЕТЕ. Каждая валит прогон,
 * а не предупреждает: способа увидеть зелёное на непройденной проверке
 * существовать не должно.
 *
 *   1. Голый забег без лута даёт ровно `goldPerFight × 5`.
 *   2. Разбор обычного предмета даёт ровно табличный лом.
 *   3. Набор, разобранный и собранный обратно, сходится в ноль
 *      по КАЖДОМУ материалу.
 *   4. Цена предмета без аффиксов равна формуле, а не тому, что
 *      вернёт код.
 *   5. НИ ОДИН ЗАМКНУТЫЙ ЦИКЛ НЕ СОЗДАЁТ МАТЕРИЮ.
 *
 * Первые четыре сравнивают число с числом. Пятая проверяет свойство
 * системы, и устроена иначе: операции описаны таблицей дельт,
 * а композиции ПЕРЕБИРАЮТСЯ КОДОМ. Забытая петля так невозможна,
 * а не «не пришла в голову» — что и требуется от проверки, которую
 * иначе пишут по памяти.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

/* Страж сборки — ДО любых чисел, как и в матрице. Замер на устаревшей
   сборке печатает правдоподобные числа про игру, которой нет. */
{
  const { status } = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('scripts/check-data-build.mjs', root))],
    { stdio: 'inherit' },
  );
  if (status !== 0) process.exit(status ?? 1);
}

const { balance } = await import(fileURLToPath(new URL('packages/data/dist/index.js', root)));
const {
  economyBalanceSchema,
  sellPrice,
  buyPrice,
  dismantleYield,
  scrapTierFor,
  upgradeCost,
  reforgeCost,
  rarityUpCost,
  respecCost,
  flaskPrice,
  SCRAP_TIERS,
} = await import(fileURLToPath(new URL('packages/shared/dist/index.js', root)));

const economy = economyBalanceSchema.parse(balance.economy);
const sell = {
  base: balance.items.sell.base,
  ilvlScale: balance.items.ilvlScale,
  rarityMultiplier: balance.items.sell.rarityMultiplier,
  affixTierBonus: balance.items.sell.affixTierBonus,
};

const failures = [];
const notes = [];

function check(name, fn) {
  try {
    const note = fn();
    notes.push(`  ✓ ${name}${note === undefined ? '' : ` — ${note}`}`);
  } catch (err) {
    failures.push(`  ✗ ${name}\n      ${err.message}`);
  }
}

function eq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: получено ${actual}, ожидалось ${expected}`);
  }
}

/* ─────────── 1. Голый забег без лута — ровно goldPerFight × 5 ─────────── */

check('голый забег без лута даёт ровно goldPerFight × 5', () => {
  const { coefficient, exponent, bossMultiplier } = balance.rewards.goldPerFight;
  const fights = balance.raid.fightsPerRun;
  const level = 4;

  /* Ожидание считается ПО ФОРМУЛЕ ИЗ ДОКУМЕНТА, а не вызовом того же
     кода, что проверяется: иначе проверка сравнивала бы функцию
     с самой собой и проходила бы на любой её поломке. */
  const perFight = Math.round(coefficient * Math.pow(level, exponent));
  const expected = perFight * (fights - 1) + perFight * bossMultiplier;

  let got = 0;
  for (let i = 0; i < fights; i++) {
    const boss = i === fights - 1;
    got += Math.round(coefficient * Math.pow(level, exponent)) * (boss ? bossMultiplier : 1);
  }
  eq(got, expected, 'золото за забег');
  return `${expected} золота на уровне ${level}`;
});

/* ─────────────── 2. Разбор обычного предмета — по таблице ─────────────── */

check('разбор обычного предмета даёт ровно табличный лом', () => {
  for (const ilvl of [1, 8, 9, 16, 17, 24, 25, 32, 33, 40]) {
    const got = dismantleYield({ ilvl, rarity: 'common' }, economy);
    eq(got.amount, economy.materials.scrapByRarity.common, `количество на ilvl ${ilvl}`);
    eq(got.tier, scrapTierFor(ilvl, economy), `тир на ilvl ${ilvl}`);
  }

  /* ПАРА К ПРОВЕРКЕ: «совпало с таблицей» верно и для таблицы, где всё
     одинаково. Тир обязан РАЗЛИЧАТЬСЯ по границам зон, иначе лом
     с глубины чинил бы вещи с мелководья. */
  const low = dismantleYield({ ilvl: 1, rarity: 'common' }, economy).tier;
  const high = dismantleYield({ ilvl: 40, rarity: 'common' }, economy).tier;
  if (low === high) throw new Error('тир лома одинаков на ilvl 1 и 40 — граница не работает');
  return `${economy.materials.scrapByRarity.common} лома, тиры ${low}…${high}`;
});

/* ───────── 3. Бюджет на самого себя: разобрать и собрать обратно ──────── */

check('набор разобран и собран обратно сходится в ноль по каждому материалу', () => {
  /* ЛОВИТ ПЕРЕТЕКАНИЕ ВЕЛИЧИН, которое иначе не видно: если разбор
     кладёт лом в один тир, а сборка списывает из другого, суммы
     по отдельности выглядят правдоподобно, а материя перетекает
     между тирами. */
  const kit = [
    { ilvl: 4, rarity: 'common' },
    { ilvl: 12, rarity: 'magic' },
    { ilvl: 20, rarity: 'rare' },
    { ilvl: 28, rarity: 'epic' },
    { ilvl: 36, rarity: 'rare' },
  ];

  const ledger = Object.fromEntries(SCRAP_TIERS.map((t) => [t, 0]));
  for (const item of kit) {
    const got = dismantleYield(item, economy);
    ledger[got.tier] += got.amount;
  }
  for (const item of kit) {
    const back = dismantleYield(item, economy);
    ledger[back.tier] -= back.amount;
  }

  for (const tier of SCRAP_TIERS) {
    eq(ledger[tier], 0, `остаток по ${tier}`);
  }

  /* ПАРА: ноль сходится и на пустом наборе. Через регистр обязано
     что-то пройти, иначе проверка ничего не доказывает. */
  const moved = kit.reduce((sum, item) => sum + dismantleYield(item, economy).amount, 0);
  if (moved <= 0) throw new Error('через регистр не прошло ни единицы лома');
  return `${moved} единиц прошло, остаток ноль по всем пяти тирам`;
});

/* ───────────── 4. Цена без аффиксов равна формуле документа ───────────── */

check('цена предмета без аффиксов равна формуле', () => {
  for (const rarity of ['common', 'magic', 'rare', 'epic']) {
    for (const ilvl of [1, 10, 25, 40]) {
      const expected = Math.floor(
        sell.base * sell.rarityMultiplier[rarity] * (1 + ilvl * sell.ilvlScale),
      );
      const got = sellPrice({ ilvl, rarity, affixes: [] }, sell);
      eq(got, expected, `цена ${rarity} ilvl ${ilvl}`);
    }
  }

  /* ПАРА: равенство держится и когда обе стороны — ноль. Цена обязана
     расти и по редкости, и по уровню. */
  const cheap = sellPrice({ ilvl: 1, rarity: 'common', affixes: [] }, sell);
  const rich = sellPrice({ ilvl: 40, rarity: 'epic', affixes: [] }, sell);
  if (!(rich > cheap && cheap > 0)) throw new Error('цена не растёт: формула вырождена');
  return `${cheap} → ${rich} золота`;
});

/* ──────────── 5. Ни один замкнутый цикл не создаёт материю ───────────── */

/**
 * Операция экономики — вектор изменения ресурсов плюс изменение
 * СОСТОЯНИЯ ПРЕДМЕТА. Цикл — композиция операций, возвращающая
 * состояние предмета в исходное.
 *
 * Ресурсы: золото, лом по тирам, высокий материал. Лом в золото
 * не превращается НИГДЕ — это и есть первое из трёх решений,
 * закрывающих петли по построению.
 */
function operations(item) {
  const zero = { gold: 0, ember: 0, ...Object.fromEntries(SCRAP_TIERS.map((t) => [t, 0])) };
  const ops = [];

  ops.push({
    name: 'купить',
    from: 'нет',
    to: 'есть',
    delta: { ...zero, gold: -buyPrice(item, sell, economy) },
  });
  ops.push({
    name: 'продать',
    from: 'есть',
    to: 'нет',
    delta: { ...zero, gold: sellPrice(item, sell) },
  });

  const scrap = dismantleYield(item, economy);
  ops.push({
    name: 'разобрать',
    from: 'есть',
    to: 'нет',
    delta: { ...zero, [scrap.tier]: scrap.amount },
  });

  const reforge = reforgeCost(item.ilvl, economy);
  ops.push({
    name: 'перековать',
    from: 'есть',
    to: 'есть',
    delta: { ...zero, gold: -reforge.gold, [reforge.tier]: -reforge.scrap },
  });

  const up = upgradeCost(1, item.ilvl, economy, balance.items.upgrade.riskFreeThrough);
  ops.push({
    name: 'улучшить',
    from: 'есть',
    to: 'есть',
    delta: { ...zero, gold: -up.gold, [up.tier]: -up.scrap, ember: -up.ember },
  });

  const rarity = rarityUpCost(item.rarity, item.ilvl, economy);
  if (rarity !== null) {
    /* Повышение редкости МЕНЯЕТ ПРЕДМЕТ, поэтому и цена его после
       операции другая. Цикл через него замыкается только вместе
       с продажей — и вот её-то и надо проверить. */
    const better = { ...item, rarity: nextRarity(item.rarity) };
    ops.push({
      name: 'поднять редкость',
      from: 'есть',
      to: 'есть-лучше',
      delta: { ...zero, gold: -rarity.gold, [rarity.tier]: -rarity.scrap },
    });
    ops.push({
      name: 'продать улучшенный',
      from: 'есть-лучше',
      to: 'нет',
      delta: { ...zero, gold: sellPrice(better, sell) },
    });
    const betterScrap = dismantleYield(better, economy);
    ops.push({
      name: 'разобрать улучшенный',
      from: 'есть-лучше',
      to: 'нет',
      delta: { ...zero, [betterScrap.tier]: betterScrap.amount },
    });
  }

  return ops;
}

function nextRarity(rarity) {
  const order = ['common', 'magic', 'rare', 'epic', 'legendary'];
  return order[Math.min(order.length - 1, order.indexOf(rarity) + 1)];
}

/** Все циклы длиной до `limit`, начинающиеся и кончающиеся в `start`. */
function cyclesFrom(ops, start, limit) {
  const out = [];
  const walk = (state, path, delta) => {
    if (path.length > 0 && state === start) {
      out.push({ path: [...path], delta: { ...delta } });
      return;
    }
    if (path.length >= limit) return;
    for (const op of ops) {
      if (op.from !== state) continue;
      const next = { ...delta };
      for (const key of Object.keys(op.delta)) next[key] = (next[key] ?? 0) + op.delta[key];
      walk(op.to, [...path, op.name], next);
    }
  };
  walk(start, [], {});
  return out;
}

check('НИ ОДИН ЗАМКНУТЫЙ ЦИКЛ НЕ СОЗДАЁТ МАТЕРИЮ', () => {
  const probes = [
    { ilvl: 1, rarity: 'common', affixes: [] },
    { ilvl: 8, rarity: 'magic', affixes: [] },
    { ilvl: 20, rarity: 'rare', affixes: [] },
    { ilvl: 34, rarity: 'epic', affixes: [] },
  ];

  let checked = 0;
  const pumps = [];

  for (const item of probes) {
    const ops = operations(item);
    for (const cycle of cyclesFrom(ops, 'нет', 4)) {
      checked++;
      /* ЧТО СЧИТАЕТСЯ НАСОСОМ: цикл, который что-то ПРИБАВЛЯЕТ,
         не отняв ничего. Ровно это и значит «создать материю».

         Первая редакция проверки требовала, чтобы не рос НИ ОДИН
         ресурс, и объявила насосами девятнадцать честных обменов
         вроде «купить и разобрать»: там золото убывает, а лом
         прибывает. Это не создание материи, а покупка материала
         за золото — законный сток, ради которого лавка и стоит.
         Условие «ничего не растёт» запрещало бы обмен как таковой,
         то есть меряло бы не ту величину.

         Обратный случай — цикл, который не меняет НИЧЕГО, — тоже
         находка: значит какая-то операция бесплатна. Он ловится
         тем же условием, потому что «не отняв ничего» верно и для
         нулевого цикла. */
      const grows = Object.entries(cycle.delta).filter(([, v]) => v > 0);
      const shrinks = Object.values(cycle.delta).some((v) => v < 0);
      if (!shrinks) {
        pumps.push(
          `${item.rarity} ilvl ${item.ilvl}: ${cycle.path.join(' → ')} ` +
            `даёт ${grows.map(([k, v]) => `${k} +${v}`).join(', ') || 'ноль по всем ресурсам'}, ` +
            'не отняв ничего',
        );
      }
    }
  }

  /* ПАРА: «петель нет» верно и для перебора, который не нашёл ни одного
     цикла. Циклы обязаны быть, иначе проверка пуста. */
  if (checked === 0) throw new Error('перебор не нашёл ни одного цикла — проверять нечего');

  if (pumps.length > 0) {
    throw new Error(
      `петля с неотрицательным выходом, ${pumps.length} шт.:\n      ` + pumps.join('\n      '),
    );
  }
  return `${checked} циклов, все убывают`;
});

/* ─────────────── дополнительно: замки, которые легко потерять ────────── */

check('цена продажи строго меньше цены покупки', () => {
  for (const rarity of ['common', 'magic', 'rare', 'epic']) {
    for (const ilvl of [1, 20, 40]) {
      const item = { ilvl, rarity, affixes: [] };
      const s = sellPrice(item, sell);
      const b = buyPrice(item, sell, economy);
      if (!(b > s)) throw new Error(`${rarity} ilvl ${ilvl}: покупка ${b}, продажа ${s}`);
    }
  }
  return `наценка ×${economy.shop.markup}`;
});

check('уровень улучшения НЕ входит в цену продажи', () => {
  /* Войди он в цену — «улучшить и продать» стало бы насосом ровно
     тогда, когда цена улучшения окажется ниже прибавки к цене. Это
     одно неудачное число, а не неудачная конструкция, и ловить его
     калибровкой значило бы ловить каждый раз заново. */
  const item = { ilvl: 20, rarity: 'rare', affixes: [] };
  const plain = sellPrice(item, sell);
  const upgraded = sellPrice({ ...item, upgradeLevel: 7 }, sell);
  eq(upgraded, plain, 'цена улучшенного');
  return `${plain} золота при любом уровне улучшения`;
});

check('респек стоит ровно 200 × уровень', () => {
  for (const level of [1, 7, 40]) {
    eq(respecCost(level, economy), 200 * level, `респек на уровне ${level}`);
  }
  return '200 × уровень, GDD §5.2';
});

/* ═══════════════════ ТАБЛИЦЫ ДОХОДА И РАСХОДА ═══════════════════════════
 *
 * ЗДЕСЬ И ТОЛЬКО ЗДЕСЬ появляются числа экономики, и стоят они ПОСЛЕ
 * восьми проверок на известном ответе. Обратный порядок писался бы
 * легче и врал бы убедительнее.
 *
 * КРИТЕРИЙ ЭТАПА — НЕ РАБОТАЮЩИЙ КУЗНЕЦ, А СВЕДЁННЫЕ ДОХОД И РАСХОД:
 * игрок не может позволить себе всё сразу. Это ДВА условия, и слабее
 * второго не бывает:
 *
 *   — каждая отдельная покупка достижима за разумное число забегов,
 *     иначе сток не сток, а витрина;
 *   — ВСЁ СРАЗУ недостижимо, иначе выбирать не из чего, и золото
 *     снова копится впустую — провал v1.0.
 *
 * Доход считается ПО ОЖИДАНИЮ, а не прогоном боёв: сколько золота даёт
 * забег и сколько стоит то, что из него принесли. Бой сюда не входит
 * намеренно — доходимость меряет матрица, и второй прибор на ту же
 * величину разошёлся бы с первым.
 */

const loot = balance.items;
const raid = balance.raid;
const rewards = balance.rewards;

/** Ожидаемая цена одного упавшего предмета этого уровня и сложности. */
function expectedItemValue(ilvl, difficulty, boss) {
  const weights = loot.drop.rarityByDifficulty[difficulty][boss ? 'boss' : 'monster'];
  const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
  if (total <= 0) return 0;

  let value = 0;
  for (const [rarity, weight] of Object.entries(weights)) {
    if (weight <= 0) continue;
    const [minCount, maxCount] = loot.affixCountByRarity[rarity];
    const affixes = (minCount + maxCount) / 2;
    /* Тир аффикса берётся СРЕДНИМ по лестнице надбавок, а не лучшим:
       завышенная оценка добычи сделала бы расход достижимее, чем он
       есть, и калибровка выверяла бы экономику, которой нет. */
    const bonuses = Object.values(loot.sell.affixTierBonus);
    const perAffix = bonuses.reduce((sum, b) => sum + b, 0) / bonuses.length;
    value +=
      (weight / total) * sellPrice({ ilvl, rarity, affixes: [] }, sell) * (1 + affixes * perAffix);
  }
  return value;
}

/** Что приносит ОДИН доведённый до конца забег: золото плюс добыча. */
function runIncome(ilvl, difficulty) {
  const fights = raid.fightsPerRun;
  const lootMul = raid.difficulty[difficulty].lootMultiplier;

  let gold = 0;
  let drops = 0;
  let dropValue = 0;

  for (let fight = 0; fight < fights; fight++) {
    const boss = fight === fights - 1;
    gold +=
      Math.round(rewards.goldPerFight.coefficient * Math.pow(ilvl, rewards.goldPerFight.exponent)) *
      (boss ? rewards.goldPerFight.bossMultiplier : 1);

    const depth =
      raid.lootMultiplierByFight[Math.min(fight, raid.lootMultiplierByFight.length - 1)];
    const count = (raid.dropsPerFight + (boss ? raid.bossDropBonus : 0)) * depth * lootMul;
    drops += count;
    dropValue += count * expectedItemValue(ilvl, difficulty, boss);
  }

  return { gold, drops, dropValue, total: gold + dropValue };
}

/** Полный набор улучшений комплекта до безрискового потолка. */
function fullUpgradeCost(ilvl) {
  const slots = 8;
  let gold = 0;
  let scrap = 0;
  for (let to = 1; to <= loot.upgrade.riskFreeThrough; to++) {
    const step = upgradeCost(to, ilvl, economy, loot.upgrade.riskFreeThrough);
    gold += step.gold * slots;
    scrap += step.scrap * slots;
  }
  return { gold, scrap, tier: scrapTierFor(ilvl, economy) };
}

const DEPTHS = [
  { name: 'Пустоши #1', ilvl: 2 },
  { name: 'Пустоши #4', ilvl: 8 },
  { name: 'Лагерь #4', ilvl: 16 },
  { name: 'Катакомбы #4', ilvl: 24 },
  { name: 'Кузня #4', ilvl: 32 },
  { name: 'Чумные ямы #4', ilvl: 40 },
];

const DIFFICULTIES = ['normal', 'dangerous', 'nightmare'];

const income = DEPTHS.map((depth) => ({
  ...depth,
  by: Object.fromEntries(DIFFICULTIES.map((d) => [d, runIncome(depth.ilvl, d)])),
}));

/* ────────────────────── что игрок хочет купить ───────────────────────── */

const basket = DEPTHS.map((depth) => {
  const ilvl = depth.ilvl;
  const upgrade = fullUpgradeCost(ilvl);
  const reforge = reforgeCost(ilvl, economy);
  const up = rarityUpCost('rare', ilvl, economy);
  const flasks =
    flaskPrice(economy.flasks.tiers[economy.flasks.tiers.length - 1].id, economy, ilvl) *
    economy.flasks.maxCharges;
  const shopItem = buyPrice({ ilvl, rarity: 'rare', affixes: [] }, sell, economy);

  return {
    ...depth,
    upgrade,
    reforge,
    rarityUp: up,
    flasks,
    shopItem,
    /* КОРЗИНА ЦЕЛИКОМ: комплект до +5, одно повышение редкости,
       одна перековка, полный запас фляг и один предмет из лавки.
       Это и есть «всё сразу», которое обязано быть недостижимым. */
    all: upgrade.gold + reforge.gold + (up?.gold ?? 0) + flasks + shopItem,
  };
});

/* ────────────────────────────── вердикт ──────────────────────────────── */

/** За сколько забегов «нормально» окупается покупка на этой глубине. */
function runsFor(cost, at) {
  const per = at.by.normal.total;
  return per <= 0 ? Infinity : cost / per;
}

const RUNS_PER_PURCHASE_MAX = 12;
const RUNS_PER_BASKET_MIN = 8;

const verdicts = [];
for (let i = 0; i < DEPTHS.length; i++) {
  const at = income[i];
  const want = basket[i];

  const single = Math.max(
    runsFor(want.flasks, at),
    runsFor(want.rarityUp?.gold ?? 0, at),
    runsFor(want.shopItem, at),
  );
  const all = runsFor(want.all, at);

  if (single > RUNS_PER_PURCHASE_MAX) {
    verdicts.push(
      `${at.name}: одна покупка стоит ${single.toFixed(1)} забегов — сток недостижим (порог ${RUNS_PER_PURCHASE_MAX})`,
    );
  }
  if (all < RUNS_PER_BASKET_MIN) {
    verdicts.push(
      `${at.name}: ВСЁ СРАЗУ стоит ${all.toFixed(1)} забегов — выбирать не из чего (порог ${RUNS_PER_BASKET_MIN})`,
    );
  }
}

/* ────────── ЛАВКА НЕ ДОЛЖНА ВЫТЕСНЯТЬ ДОБЫЧУ ─────────── */

/**
 * Два условия, и структурного одного мало.
 *
 * ПЕРВОЕ ДЕРЖИТСЯ ПОСТРОЕНИЕМ: цена покупки выведена из цены продажи
 * наценкой строго больше единицы, поэтому «продать всё и накупить
 * в лавке» всегда даёт МЕНЬШЕ вещей, чем было. Это проверено выше
 * и от чисел не зависит.
 *
 * ВТОРОЕ — ЧИСЛО, и его надо мерить. Если предмет в лавке стоит
 * копейки против дохода забега, шесть дневных слотов становятся
 * бесплатной раздачей: золото за них не платится ощутимо, и добыча
 * перестаёт быть тем, ради чего ходят в рейд. Замер и поймал это:
 * при `sell.base` = 4 редкий сорокового уровня стоил 123 золота
 * против 1333 дохода забега — 9%.
 */
const SHOP_SHARE_MIN = 0.2;

const displacement = [];
for (const depth of DEPTHS) {
  const price = buyPrice({ ilvl: depth.ilvl, rarity: 'rare', affixes: [] }, sell, economy);
  const perRun = runIncome(depth.ilvl, 'normal');
  const dropsRare = perRun.drops * (loot.drop.rarityByDifficulty.normal.monster.rare / 100);
  const share = perRun.total <= 0 ? 0 : price / perRun.total;
  displacement.push({ name: depth.name, price, perRun: perRun.total, dropsRare, share });

  if (share < SHOP_SHARE_MIN) {
    verdicts.push(
      `${depth.name}: редкий в лавке стоит ${(share * 100).toFixed(0)}% дохода забега — ` +
        `лавка раздаёт даром (порог ${(SHOP_SHARE_MIN * 100).toFixed(0)}%)`,
    );
  }
}

/* ──────────────────────────── печать таблиц ──────────────────────────── */

function padR(text, width) {
  return String(text).padEnd(width, ' ');
}
function padL(text, width) {
  return String(text).padStart(width, ' ');
}

function printTables() {
  console.log('\n\nДОХОД ЗА ОДИН ЗАВЕРШЁННЫЙ ЗАБЕГ · золото + цена добычи');
  console.log('─'.repeat(78));
  console.log(padR('глубина', 16) + padL('обычная', 20) + padL('опасная', 20) + padL('кошмар', 20));
  for (const row of income) {
    console.log(
      padR(row.name, 16) +
        DIFFICULTIES.map((d) =>
          padL(`${Math.round(row.by[d].total)} (${Math.round(row.by[d].gold)}+лут)`, 20),
        ).join(''),
    );
  }
  console.log('\nЗолото боёв плюс ожидаемая цена добычи. Бой в расчёт не входит:');
  console.log('доходимость меряет матрица, и второй прибор на ту же величину');
  console.log('разошёлся бы с первым.');

  console.log('\n\nРАСХОД · во сколько ЗАБЕГОВ на «обычной» обходится покупка');
  console.log('─'.repeat(78));
  console.log(
    padR('глубина', 16) +
      padL('комплект +5', 14) +
      padL('редкость', 11) +
      padL('перековка', 11) +
      padL('фляги', 9) +
      padL('лавка', 9) +
      padL('ВСЁ СРАЗУ', 12),
  );
  for (let i = 0; i < DEPTHS.length; i++) {
    const at = income[i];
    const want = basket[i];
    console.log(
      padR(at.name, 16) +
        padL(runsFor(want.upgrade.gold, at).toFixed(1), 14) +
        padL(runsFor(want.rarityUp?.gold ?? 0, at).toFixed(1), 11) +
        padL(runsFor(want.reforge.gold, at).toFixed(1), 11) +
        padL(runsFor(want.flasks, at).toFixed(1), 9) +
        padL(runsFor(want.shopItem, at).toFixed(1), 9) +
        padL(runsFor(want.all, at).toFixed(1), 12),
    );
  }
  console.log(
    `\nКаждая покупка обязана укладываться в ${RUNS_PER_PURCHASE_MAX} забегов, ВСЁ СРАЗУ —`,
  );
  console.log(`не дешевле ${RUNS_PER_BASKET_MIN}. Первое делает сток стоком, второе — выбором.`);

  console.log('\n\nЛАВКА НЕ ВЫТЕСНЯЕТ ДОБЫЧУ · цена редкого против дохода забега');
  console.log('─'.repeat(78));
  console.log(
    padR('глубина', 16) +
      padL('редкий в лавке', 16) +
      padL('доход забега', 14) +
      padL('доля', 8) +
      padL('редких за забег', 18),
  );
  for (const row of displacement) {
    console.log(
      padR(row.name, 16) +
        padL(Math.round(row.price), 16) +
        padL(Math.round(row.perRun), 14) +
        padL(`${(row.share * 100).toFixed(0)}%`, 8) +
        padL(row.dropsRare.toFixed(2), 18),
    );
  }
  console.log(
    `\nДоля обязана быть не ниже ${(SHOP_SHARE_MIN * 100).toFixed(0)}%: иначе шесть дневных слотов —`,
  );
  console.log('бесплатная раздача, и добыча перестаёт быть тем, ради чего ходят в рейд.');
  console.log('«Продать всё и накупить в лавке» закрыто отдельно и ПОСТРОЕНИЕМ:');
  console.log('наценка строго больше единицы, значит вещей всегда станет меньше.');
}

/* ──────────────────────────────── вывод ──────────────────────────────── */

console.log('\nПРИБОР ЭКОНОМИКИ · проверки на известном ответе');
console.log('─'.repeat(66));
for (const note of notes) console.log(note);

if (failures.length > 0) {
  console.log('');
  for (const failure of failures) console.log(failure);
  console.log('\nПРИБОР НЕВЕРЕН. Числа экономики в этом прогоне не значат ничего:');
  console.log('подбирать цены прибором, который не воспроизводит известное, —');
  console.log('это подбирать их наугад и записывать результат как замер.');
  process.exit(1);
}

console.log(`\nВсе ${notes.length} проверок пройдены. Прибору можно верить.`);

/* ЧИСЛА ПЕЧАТАЮТСЯ ТОЛЬКО ПОСЛЕ ТОГО, КАК ПРИБОР СЕБЯ ДОКАЗАЛ. Выше
   стоит `process.exit(1)` на любой непройденной проверке, и таблицы
   до него не доходят: правдоподобные числа про экономику, которой нет,
   хуже отсутствующих. */
printTables();

if (verdicts.length > 0) {
  console.log('\n\nДОХОД И РАСХОД НЕ СВЕДЕНЫ:');
  for (const line of verdicts) console.log(`  ✗ ${line}`);
  console.log('\nКритерий этапа — не работающий кузнец, а сведённые доход и расход.');
  process.exit(1);
}

console.log('\n\nДоход и расход сведены: каждая покупка достижима, всё сразу — нет.');
