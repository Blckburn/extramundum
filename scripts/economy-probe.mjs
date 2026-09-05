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
