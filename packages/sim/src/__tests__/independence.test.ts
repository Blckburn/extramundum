import { describe, expect, it } from 'vitest';

import { resolveAttack } from '../damage.js';
import { createFighterState } from '../fighter.js';
import { rngFromSeed, type Rng } from '../rng.js';
import { balance, fighter } from './helpers.js';

/**
 * Независимость бросков. GDD §4.2 и §13, пункт 5.
 *
 * В v1.0 уклонение и блок делили один `r` внутри `pickMove()`. Следствие:
 * шанс блока зависел от шанса уклонения — поднимаешь AGI, и щит начинает
 * работать иначе, хотя щит тот же. Такую поломку нельзя заметить глазами
 * и нельзя вывести из кода за разумное время, её видно только измерением.
 *
 * Поэтому здесь статистика, а не единичный вызов: каждый бросок обязан
 * иметь свой вызов генератора, и частоты обязаны сходиться с формулами.
 */

const RUNS = 20_000;

/** Прогон N ударов, считаем, чем они кончились. */
function sample(
  attackerOverrides: Parameters<typeof fighter>[0],
  defenderOverrides: Parameters<typeof fighter>[0],
  seed: string,
): { dodged: number; blocked: number; crit: number; hits: number } {
  const attacker = createFighterState(fighter(attackerOverrides), balance);
  const defender = createFighterState(fighter(defenderOverrides), balance);
  const rng = rngFromSeed(seed);

  let dodged = 0;
  let blocked = 0;
  let crit = 0;
  let hits = 0;

  for (let i = 0; i < RUNS; i++) {
    const outcome = resolveAttack(attacker, defender, balance, rng, 0, 1);
    if (outcome.kind === 'dodged') {
      dodged++;
      continue;
    }
    hits++;
    if (outcome.crit) crit++;
    if (outcome.roll.blockReduction > 0) blocked++;
  }

  return { dodged, blocked, crit, hits };
}

describe('частоты сходятся с формулами', () => {
  it('уклонение выпадает с расчётной вероятностью', () => {
    // AGI 20 против ACC 8 → 12.6% (пример из GDD §4.2).
    const { dodged } = sample({ accuracy: 8 }, { agi: 20 }, 'dodge-rate');
    expect(dodged / RUNS).toBeCloseTo(0.126, 2);
  });

  it('крит выпадает с расчётной вероятностью', () => {
    // AGI 20 → 13% (пример из GDD §4.2). Считаем от ударов, дошедших
    // до шага крита, а не от всех попыток.
    const { crit, hits } = sample({ agi: 20 }, { agi: 0 }, 'crit-rate');
    expect(crit / hits).toBeCloseTo(0.13, 2);
  });

  it('блок выпадает с вероятностью щита', () => {
    const { blocked, hits } = sample(
      { accuracy: 1000 }, // уклонений нет, все удары доходят до блока
      { offhand: { kind: 'shield', blockChance: 0.25, blockReduction: 0.8 } },
      'block-rate',
    );
    expect(blocked / hits).toBeCloseTo(0.25, 2);
  });
});

describe('броски не коррелируют между собой', () => {
  it('шанс блока не зависит от ловкости защитника', () => {
    // ГЛАВНАЯ проверка файла: ровно баг v1.0 №5.
    //
    // Точность атакующего здесь НЕ задирается. Обнулить уклонение —
    // значит убрать то самое, с чем ищется корреляция: при нулевом
    // шансе уклонения общий бросок неотличим от раздельного. Первая
    // редакция этого теста именно так и промахнулась мимо диверсии.
    //
    // Поэтому уклонение оставлено живым и РАЗНЫМ: 3% против 27%.
    // При общем броске (`r < dodge` → уклон, иначе `r < dodge + block`
    // → блок) доля блоков среди дошедших ударов равна block/(1 − dodge),
    // то есть 0.309 против 0.411. При раздельных бросках — 0.3 в обоих.
    const offhand = { kind: 'shield', blockChance: 0.3, blockReduction: 0.7 } as const;

    const slow = sample({}, { agi: 0, offhand }, 'corr-a'); // уклонение 3%
    const nimble = sample({}, { agi: 30, offhand }, 'corr-b'); // уклонение 27%

    // Проверяем, что уклонение действительно разное: иначе тест
    // незаметно выродится в предыдущую редакцию.
    expect(slow.dodged / RUNS).toBeCloseTo(0.03, 2);
    expect(nimble.dodged / RUNS).toBeCloseTo(0.27, 2);

    const slowRate = slow.blocked / slow.hits;
    const nimbleRate = nimble.blocked / nimble.hits;

    expect(slowRate).toBeCloseTo(0.3, 2);
    expect(nimbleRate).toBeCloseTo(0.3, 2);
    expect(Math.abs(slowRate - nimbleRate)).toBeLessThan(0.02);
  });

  it('шанс крита не зависит от того, есть ли у защитника щит', () => {
    const withShield = sample(
      { agi: 20, accuracy: 1000 },
      { offhand: { kind: 'shield', blockChance: 0.5, blockReduction: 0.6 } },
      'crit-shield',
    );
    const without = sample({ agi: 20, accuracy: 1000 }, { offhand: null }, 'crit-no-shield');

    expect(Math.abs(withShield.crit / withShield.hits - without.crit / without.hits)).toBeLessThan(
      0.02,
    );
  });

  it('шанс уклонения не зависит от наличия щита', () => {
    const withShield = sample(
      {},
      { agi: 25, offhand: { kind: 'shield', blockChance: 0.35, blockReduction: 0.9 } },
      'dodge-shield',
    );
    const without = sample({}, { agi: 25, offhand: null }, 'dodge-no-shield');

    expect(Math.abs(withShield.dodged / RUNS - without.dodged / RUNS)).toBeLessThan(0.02);
  });
});

describe('сам генератор', () => {
  it('равномерен по десяти корзинам', () => {
    const rng = rngFromSeed('uniform');
    const buckets = new Array<number>(10).fill(0);

    for (let i = 0; i < 100_000; i++) {
      const idx = Math.min(9, Math.floor(rng.next() * 10));
      buckets[idx] = (buckets[idx] ?? 0) + 1;
    }

    for (const count of buckets) {
      expect(count / 100_000).toBeCloseTo(0.1, 2);
    }
  });

  it('соседние значения не коррелируют', () => {
    const rng = rngFromSeed('serial');
    const n = 50_000;
    let sumXY = 0;
    let sumX = 0;
    let sumY = 0;
    let sumX2 = 0;
    let sumY2 = 0;

    let prev = rng.next();
    for (let i = 0; i < n; i++) {
      const cur = rng.next();
      sumXY += prev * cur;
      sumX += prev;
      sumY += cur;
      sumX2 += prev * prev;
      sumY2 += cur * cur;
      prev = cur;
    }

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    expect(Math.abs(numerator / denominator)).toBeLessThan(0.02);
  });

  it('int попадает в границы включительно', () => {
    const rng = rngFromSeed('bounds');
    const seen = new Set<number>();

    for (let i = 0; i < 5000; i++) {
      const v = rng.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
      seen.add(v);
    }

    expect(seen.size).toBe(5);
  });

  it('число бросков за удар не зависит от бойцов при одинаковом исходе', () => {
    // Свойство, ради которого `chance` тратит бросок и на границах,
    // а шаги 0 и 2 бросают безусловно. Без него два билда, отличающиеся
    // одним коэффициентом, расходятся ПОТОКОМ генератора, и матрица
    // винрейтов §4.6 меряет смещение выборки вместо силы правки: ровно
    // так `slippery` с нулевым множителем крита показал на четыре пункта
    // больше, чем с множителем 0.05.
    //
    // Сравниваются пары, у которых исход обязан совпасть ПОЛНОСТЬЮ:
    // трейт с нулевым шансом избегания ничего не меняет, щит с нулевым
    // шансом блока — тоже. Значит и бросков должно уйти поровну.
    const counted = (seed: string) => {
      const base = rngFromSeed(seed);
      let draws = 0;
      const rng: Rng = {
        next: () => (draws++, base.next()),
        int: (a, b) => (draws++, base.int(a, b)),
        chance: (p) => (draws++, base.chance(p)),
        state: () => base.state(),
      };
      return { rng, draws: () => draws };
    };

    /**
     * Пара варьируется С ОБЕИХ СТОРОН.
     *
     * Прежняя редакция меняла только защитника, и диверсия «второе
     * оружие тратит свой бросок» проходила мимо: второе оружие
     * принадлежит АТАКУЮЩЕМУ. Проверка, смотрящая на одну сторону,
     * доказывает ровно половину.
     */
    const hit = (
      attacker: Parameters<typeof fighter>[0],
      defender: Parameters<typeof fighter>[0],
      seed: string,
    ) => {
      const { rng, draws } = counted(seed);
      const a = createFighterState(fighter({ atk: 20, accuracy: 5, ...attacker }), balance);
      const d = createFighterState(fighter(defender), balance);
      const outcome = resolveAttack(a, d, balance, rng, 0, 1);
      return { kind: outcome.kind, draws: draws() };
    };

    type Side = {
      attacker?: Parameters<typeof fighter>[0];
      defender?: Parameters<typeof fighter>[0];
    };

    const deadShield = { kind: 'shield', blockChance: 0, blockReduction: 0.3 } as const;
    const secondWeapon = { kind: 'weapon', dmgMin: 0, dmgMax: 0 } as const;
    const focus = { kind: 'focus', statusPower: 1.4 } as const;

    const pairs: Array<[string, Side, Side]> = [
      // Щит, который никогда не срабатывает, против отсутствия оффхенда.
      [
        'щит с нулевым блоком',
        { defender: { agi: 20 } },
        { defender: { agi: 20, offhand: deadShield } },
      ],

      // ТРИ ВИДА ОФФХЕНДА (M3a). Самая опасная правка этапа: блок
      // бросается у всех, второе оружие складывается в ТОТ ЖЕ бросок
      // урона, фокус не бросает вовсе. Разойдись здесь число бросков —
      // вся калибровка M1c поехала бы потоком, а не силой правки.
      //
      // Оффхенд проверяется НА ОБЕИХ сторонах: у защитника он влияет
      // на шаг блока, у атакующего — на шаг урона.
      [
        'второе оружие у защитника',
        { defender: { agi: 20 } },
        { defender: { agi: 20, offhand: secondWeapon } },
      ],
      [
        'второе оружие у АТАКУЮЩЕГО',
        { attacker: {}, defender: { agi: 20 } },
        { attacker: { offhand: secondWeapon }, defender: { agi: 20 } },
      ],
      ['фокус у защитника', { defender: { agi: 20 } }, { defender: { agi: 20, offhand: focus } }],
      [
        'фокус у АТАКУЮЩЕГО',
        { attacker: {}, defender: { agi: 20 } },
        { attacker: { offhand: focus }, defender: { agi: 20 } },
      ],
      [
        'фокус против щита',
        { defender: { agi: 20, offhand: focus } },
        { defender: { agi: 20, offhand: deadShield } },
      ],

      // Аффиксы «Мощи» меняют ЧИСЛО урона, но не число бросков —
      // ни у того, кто их носит, ни у того, по кому бьют.
      [
        'аффиксы Мощи у атакующего',
        { attacker: {}, defender: { agi: 20 } },
        {
          attacker: { percentAffixes: { might: [0.12, 0.15, 0.15], bastion: [], swiftness: [] } },
          defender: { agi: 20 },
        },
      ],
    ];

    let sameOutcome = 0;
    let hits = 0;
    let misses = 0;

    for (let i = 0; i < 300; i++) {
      for (const [name, left, right] of pairs) {
        const a = hit(left.attacker ?? {}, left.defender ?? {}, `draws-${i}`);
        const b = hit(right.attacker ?? {}, right.defender ?? {}, `draws-${i}`);
        expect(b.kind, `${name}: исход разошёлся, сравнивать броски нельзя`).toBe(a.kind);
        expect(b.draws, `${name}: разное число бросков при одинаковом исходе`).toBe(a.draws);
        sameOutcome++;
        if (a.kind === 'hit') hits++;
        else misses++;
      }
    }

    // В выборке ЕСТЬ и попадания, и промахи: у них разное число бросков,
    // и проверка выше без обоих доказывала бы только одну ветку.
    expect(sameOutcome).toBe(300 * pairs.length);
    expect(hits, 'ни одного попадания в выборке').toBeGreaterThan(30);
    expect(misses, 'ни одного промаха в выборке').toBeGreaterThan(10);
  });

  it('ветки удара тратят разное, но фиксированное число бросков', () => {
    // Числа заданы пайплайном §4.2: избегание — 1 бросок, уклонение — 2,
    // попадание — 5 (избегание, уклонение, блок, урон оружия, крит).
    // Проверка не на «одинаково», а на КОНКРЕТНЫЕ значения: иначе
    // генератор, не тратящий ничего, прошёл бы её с нулями.
    const run = (defender: Parameters<typeof fighter>[0], seed: string) => {
      const base = rngFromSeed(seed);
      let draws = 0;
      const rng: Rng = {
        next: () => (draws++, base.next()),
        int: (a, b) => (draws++, base.int(a, b)),
        chance: (p) => (draws++, base.chance(p)),
        state: () => base.state(),
      };
      const a = createFighterState(fighter({ atk: 20, accuracy: 0 }), balance);
      const d = createFighterState(fighter(defender), balance);
      return { kind: resolveAttack(a, d, balance, rng, 0, 1).kind, draws };
    };

    const seen = new Map<number, number>();
    for (let i = 0; i < 600; i++) {
      const r = run({ agi: 40 }, `branch-${i}`);
      seen.set(r.draws, (seen.get(r.draws) ?? 0) + 1);
    }

    // Без трейта избегания остаются две ветки: уклонение (2), попадание (5).
    expect([...seen.keys()].sort((x, y) => x - y)).toEqual([2, 5]);
    expect(seen.get(2), 'уклонений не было').toBeGreaterThan(20);
    expect(seen.get(5), 'попаданий не было').toBeGreaterThan(20);

    // Ветка избегания — ровно один бросок. Носителю даётся столько стеков
    // трейта, чтобы шанс упёрся в единицу: иначе она попадалась бы редко
    // и проверялась бы через раз.
    const avoidSeen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const r = run({ agi: 0, traits: Array(12).fill('phantom' as const) }, `avoid-${i}`);
      expect(r.kind).toBe('dodged');
      avoidSeen.add(r.draws);
    }
    expect([...avoidSeen]).toEqual([1]);
  });

  it('chance на границах отвечает верно и всё равно тратит бросок', () => {
    const rng = rngFromSeed('edges');
    for (let i = 0; i < 100; i++) {
      expect(rng.chance(0)).toBe(false);
      expect(rng.chance(1)).toBe(true);
    }

    // Состояние СДВИНУЛОСЬ ровно на 200 бросков. Раньше здесь стояло
    // обратное утверждение — «вырожденные вероятности не тратят броски», —
    // и оно закрепляло поведение, из-за которого поток генератора зависел
    // от ЗНАЧЕНИЯ коэффициента: билд с нулевым шансом расходился с билдом,
    // где шанс равен полупроценту, с первого же такого броска, и матрица
    // винрейтов мерила смещение выборки вместо силы трейта.
    const reference = rngFromSeed('edges');
    for (let i = 0; i < 200; i++) reference.next();
    expect(rng.next()).toBe(reference.next());

    // И это не совпадение двух одинаково сломанных счётчиков: генератор,
    // не потративший ничего, даёт ДРУГОЕ число.
    expect(rng.state()).not.toEqual(rngFromSeed('edges').state());
  });
});
