import type { BattleSetup, RollBreakdown } from '@extramundum/shared';
import { describe, expect, it } from 'vitest';

import { resolveBattle } from '../resolve.js';
import { rngFromSeed, rngFromState, seedToState } from '../rng.js';
import { maxHp } from '../fighter.js';
import { balance, fighter } from './helpers.js';

/**
 * Поведение боя целиком.
 *
 * Здесь проверяется не «функция что-то вернула», а свойства, на которых
 * держится всё остальное: воспроизводимость, независимость бросков,
 * границы и завершаемость.
 */

const duel = (a = {}, b = {}): BattleSetup => [fighter(a), fighter(b)];

describe('детерминизм', () => {
  it('один сид даёт побитово идентичный лог — 50 сидов', () => {
    for (let i = 0; i < 50; i++) {
      const seed = `seed-${i}`;
      const setup = duel({ atk: 12, agi: 7, spd: 11 }, { atk: 9, def: 8, armor: 30, spd: 9 });

      const first = resolveBattle(setup, balance, seed);
      const second = resolveBattle(setup, balance, seed);

      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });

  it('разные сиды дают разные бои', () => {
    const setup = duel({ atk: 10, agi: 10, spd: 10 }, { atk: 10, agi: 10, spd: 10 });
    const logs = new Set<string>();

    for (let i = 0; i < 30; i++) {
      logs.add(JSON.stringify(resolveBattle(setup, balance, `s-${i}`).log.events));
    }

    // Если бы сид не влиял, здесь была бы одна строка на все тридцать.
    expect(logs.size).toBeGreaterThan(20);
  });

  it('сид записан в логе: бой воспроизводится из самого лога', () => {
    const result = resolveBattle(duel(), balance, 'replay-me');
    expect(result.log.seed).toBe('replay-me');

    const again = resolveBattle(duel(), balance, result.log.seed);
    expect(JSON.stringify(again.log)).toBe(JSON.stringify(result.log));
  });

  it('состояние генератора сериализуемо и восстанавливается', () => {
    const rng = rngFromSeed('serialize');
    for (let i = 0; i < 10; i++) rng.next();

    const snapshot = JSON.parse(JSON.stringify(rng.state())) as ReturnType<typeof rng.state>;
    const restored = rngFromState(snapshot);

    const fromOriginal = [rng.next(), rng.next(), rng.next()];
    const fromRestored = [restored.next(), restored.next(), restored.next()];

    expect(fromRestored).toEqual(fromOriginal);
  });

  it('близкие сиды дают непохожие первые броски', () => {
    // Без перемешивания и прогрева xorshift начинает похоже, и бои
    // «seed-1» и «seed-2» открывались бы одинаково.
    const a = rngFromSeed('battle-1').next();
    const b = rngFromSeed('battle-2').next();
    expect(Math.abs(a - b)).toBeGreaterThan(0.001);
  });

  it('состояние из сида не бывает вырожденным', () => {
    const state = seedToState('');
    expect(state.s0hi + state.s0lo + state.s1hi + state.s1lo).toBeGreaterThan(0);
  });
});

describe('порядок ходов (GDD §4.1)', () => {
  it('быстрый успевает действовать чаще медленного', () => {
    const setup = duel({ spd: 30, atk: 0 }, { spd: 10, atk: 0 });
    const { log } = resolveBattle(setup, balance, 'speed');

    const turns = log.events.filter((e) => e.t === 'turn_start');
    const fast = turns.filter((e) => e.t === 'turn_start' && e.actor === 0).length;
    const slow = turns.filter((e) => e.t === 'turn_start' && e.actor === 1).length;

    // SPD обязана быть осмысленной характеристикой, а не абстрактным
    // множителем (GDD §4.1 и §13, пункт 6).
    expect(fast).toBeGreaterThan(slow * 2);
  });

  it('при равной инициативе порядок решает сид, а не позиция в массиве', () => {
    // Зеркальный бой: если бы порядок брался из массива, боец 0 всегда
    // бил бы первым и выигрывал бы все сиды подряд.
    const setup = duel({ spd: 10 }, { spd: 10 });
    const winners = new Set<number | null>();

    for (let i = 0; i < 40; i++) {
      winners.add(resolveBattle(setup, balance, `mirror-${i}`).outcome.winner);
    }

    expect(winners.size).toBeGreaterThan(1);
  });

  it('очередь не предгенерируется: урон виден следующему действию', () => {
    // Косвенная, но проверяемая примета: hpAfter монотонно убывает
    // и совпадает с накопленной суммой урона. При предгенерации
    // (GDD §13, пункт 1) состояние считалось бы в вакууме и разошлось бы.
    const setup = duel({ atk: 20, spd: 12 }, { def: 5, spd: 8 });
    const { log } = resolveBattle(setup, balance, 'sequential');

    const hp = new Map<number, number>([
      [0, maxHp(setup[0], balance)],
      [1, maxHp(setup[1], balance)],
    ]);

    for (const e of log.events) {
      if (e.t !== 'damage') continue;
      const expected = Math.max(0, (hp.get(e.target) ?? 0) - e.amount);
      expect(e.hpAfter).toBe(expected);
      hp.set(e.target, expected);
    }
  });
});

describe('завершаемость', () => {
  it('бой не зацикливается даже когда никто не может убить', () => {
    // Нулевой урон и предельная броня: раньше лимита не кончится.
    const setup = duel(
      {
        atk: 0,
        armor: 100_000,
        spd: 10,
        weapon: { dmgMin: 0, dmgMax: 0, ilvl: 1, class: 'light' },
      },
      {
        atk: 0,
        armor: 100_000,
        spd: 10,
        weapon: { dmgMin: 0, dmgMax: 0, ilvl: 1, class: 'light' },
      },
    );

    const { outcome } = resolveBattle(setup, balance, 'stalemate');

    expect(outcome.ticks).toBe(balance.tick.limit);
    expect(outcome.winner).toBeNull();
  });

  it('нормальный бой заканчивается смертью и много раньше лимита', () => {
    const setup = duel({ atk: 40, spd: 14 }, { def: 2, spd: 9 });
    const { log, outcome } = resolveBattle(setup, balance, 'normal');

    expect(outcome.winner).not.toBeNull();
    expect(outcome.ticks).toBeLessThan(balance.tick.limit);
    expect(log.events.filter((e) => e.t === 'death')).toHaveLength(1);
  });

  it('после смерти событий больше нет', () => {
    const setup = duel({ atk: 60, spd: 20 }, { spd: 5 });
    const { log } = resolveBattle(setup, balance, 'no-tail');

    const deathAt = log.events.findIndex((e) => e.t === 'death');
    expect(deathAt).toBeGreaterThanOrEqual(0);
    expect(deathAt).toBe(log.events.length - 1);
  });

  it('HP не уходит ниже нуля', () => {
    for (let i = 0; i < 20; i++) {
      const { log, outcome } = resolveBattle(
        duel({ atk: 80, spd: 15 }, { spd: 7 }),
        balance,
        `overkill-${i}`,
      );
      for (const e of log.events) {
        if (e.t === 'damage') expect(e.hpAfter).toBeGreaterThanOrEqual(0);
      }
      expect(Math.min(...outcome.hpRemaining)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('разбор броска', () => {
  it('произведение шагов даёт итог', () => {
    const { log } = resolveBattle(duel({ atk: 25, spd: 12 }, { armor: 40 }), balance, 'breakdown');

    const rolls = log.events.filter((e) => e.t === 'attack').map((e) => e.roll as RollBreakdown);
    expect(rolls.length).toBeGreaterThan(0);

    for (const r of rolls) {
      const product =
        r.weaponRoll *
        r.ilvlScale *
        r.atkMultiplier *
        r.matchupMultiplier *
        (1 - r.mitigation) *
        r.critMultiplier *
        (1 - r.blockReduction);

      // Игрок ткнёт в строку журнала и перемножит числа. Они обязаны
      // сойтись с уроном, иначе «прозрачность» — просто слово.
      expect(r.final).toBe(Math.max(0, Math.round(product)));
    }
  });

  it('урон в событии damage совпадает с итогом разбора', () => {
    const { log } = resolveBattle(duel({ atk: 18, spd: 13 }, { armor: 20 }), balance, 'match-dmg');

    for (let i = 0; i < log.events.length - 1; i++) {
      const attack = log.events[i];
      const next = log.events[i + 1];
      if (attack?.t !== 'attack') continue;
      if (next?.t !== 'damage') continue;
      expect(next.amount).toBe(attack.roll.final);
    }
  });

  it('крит виден и в разборе, и в событии урона', () => {
    const setup = duel({ agi: 200, atk: 10, spd: 12 }, { spd: 6 });
    const { log } = resolveBattle(setup, balance, 'crit');

    const crits = log.events.filter((e) => e.t === 'damage' && e.crit);
    expect(crits.length).toBeGreaterThan(0);

    for (let i = 0; i < log.events.length - 1; i++) {
      const attack = log.events[i];
      const dmg = log.events[i + 1];
      if (attack?.t !== 'attack' || dmg?.t !== 'damage') continue;
      expect(dmg.crit).toBe(attack.roll.critMultiplier > 1);
    }
  });
});

describe('границы значений в бою', () => {
  it('митигация в логе никогда не выше капа', () => {
    const { log } = resolveBattle(
      duel({ atk: 10, spd: 12 }, { armor: 1_000_000 }),
      balance,
      'dr-cap',
    );

    for (const e of log.events) {
      if (e.t === 'attack')
        expect(e.roll.mitigation).toBeLessThanOrEqual(balance.damage.mitigation.cap);
    }
  });

  it('полный блок гасит урон до нуля и это видно в разборе', () => {
    const setup = duel(
      { atk: 30, spd: 12 },
      { spd: 6, offhand: { kind: 'shield', blockChance: 1, blockReduction: 1 } },
    );
    const { log } = resolveBattle(setup, balance, 'full-block');

    // Щит у бойца 1, значит блок относится только к ударам бойца 0.
    // Ответные удары щитоносца блокировать нечем.
    const attacks = log.events.filter((e) => e.t === 'attack' && e.actor === 0);
    expect(attacks.length).toBeGreaterThan(0);

    for (const e of attacks) {
      if (e.t !== 'attack') continue;
      expect(e.roll.blockReduction).toBe(1);
      expect(e.roll.final).toBe(0);
    }

    // И наоборот: у безоружного на блок бойца 0 щита нет.
    for (const e of log.events) {
      if (e.t === 'attack' && e.actor === 1) expect(e.roll.blockReduction).toBe(0);
    }
  });

  it('без щита блока не бывает', () => {
    const { log } = resolveBattle(
      duel({ atk: 15, spd: 12 }, { offhand: null }),
      balance,
      'no-shield',
    );

    expect(log.events.filter((e) => e.t === 'block')).toHaveLength(0);
    for (const e of log.events) {
      if (e.t === 'attack') expect(e.roll.blockReduction).toBe(0);
    }
  });
});
