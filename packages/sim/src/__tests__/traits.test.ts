import {
  ALL_TRAIT_IDS,
  INNATE_TRAIT_IDS,
  MONSTER_TRAIT_IDS,
  TRAIT_IDS,
  type BattleEvent,
  type BattleSetup,
  type FighterConfig,
  type TraitId,
} from '@extramundum/shared';
import { describe, expect, it } from 'vitest';

import { createFighterState, effectiveStats } from '../fighter.js';
import { resolveBattle } from '../resolve.js';
import { createStatusClock, applyStatus, tickFighterStatuses, STATUS_ORDER } from '../statuses.js';
import { TRAITS, activeTraitModifiers, createTraitState, traitDefinition } from '../traits.js';
import { balance, fighter } from './helpers.js';

/**
 * Трейты. GDD §4.5.
 *
 * Причина, по которой этот файл длиннее остальных, названа в GDD §13,
 * пункт 3: в v1.0 шесть трейтов из семнадцати описывали одно, а делали
 * другое. THORNS «отражал 15% урона» и давал `fDef × 1.05`, PHANTOM
 * «10% полностью избежать удара» — `fAgi × 1.2`, WARLORD не был
 * реализован вовсе. Ни один тест этого не заметил, потому что тестов
 * на трейты не было.
 *
 * Отсюда два уровня проверки:
 *  1. КАЖДЫЙ из тридцати четырёх трейтов наблюдаем — он меняет либо лог,
 *     либо эффективные статы. Это ловит «объявлен и ничего не делает».
 *  2. У каждого есть отдельный тест на ЧТО ИМЕННО он делает, сверенный
 *     с числом из `balance.json` и с описанием в `locales/`.
 *
 * Правило CLAUDE.md про отрицательные проверки соблюдается: везде, где
 * тест говорит «не происходит», рядом стоит утверждение, что в тех же
 * условиях оно происходить умеет.
 */

/* ────────────────────────────── обвязка ──────────────────────────────── */

const T = (id: TraitId, key: string): number => {
  const value = balance.traits[id]?.[key];
  if (value === undefined) throw new Error(`нет balance.traits.${id}.${key}`);
  return value;
};

/** Боец, чей ход гарантированно первый и чей удар гарантированно попадает. */
const striker = (overrides: Partial<FighterConfig> = {}): FighterConfig =>
  fighter({ spd: 40, accuracy: 500, atk: 20, ...overrides });

/** Мешок: не бьёт, не уклоняется, много HP — наблюдаем чужой эффект чисто. */
const dummy = (overrides: Partial<FighterConfig> = {}): FighterConfig =>
  fighter({
    spd: 1,
    agi: 0,
    atk: 0,
    pathBonusHp: 400,
    weapon: { dmgMin: 0, dmgMax: 0, ilvl: 1, class: 'balanced' },
    ...overrides,
  });

const fight = (a: FighterConfig, b: FighterConfig, seed = 'trait-probe') =>
  resolveBattle([a, b] as BattleSetup, balance, seed);

const fires = (events: readonly BattleEvent[], trait: TraitId, actor?: 0 | 1) =>
  events.filter(
    (e) => e.t === 'trait_fire' && e.trait === trait && (actor === undefined || e.actor === actor),
  );

const applies = (events: readonly BattleEvent[], status: string, target?: 0 | 1) =>
  events.filter(
    (e) =>
      e.t === 'status_apply' &&
      e.status === status &&
      (target === undefined || e.target === target),
  );

/**
 * Раненый боец: часть пассивов смотрит на долю HP, и на полном HP они
 * молчат по определению. Тест «трейт наблюдаем» обязан ставить условие,
 * в котором трейт ОБЯЗАН сработать, иначе он проверяет молчание.
 */
function hurt(config: Partial<FighterConfig>, fraction: number) {
  const state = createFighterState(fighter({ pathBonusHp: 200, ...config }), balance);
  state.hp = Math.max(1, Math.floor(state.maxHp * fraction));
  return state;
}

/**
 * Боец с уже наложенным статусом.
 *
 * `createFighterState` стартовые статусы НЕ накладывает — это делает
 * `resolveBattle`. Если про это забыть, `butcher` «не наблюдаем»
 * не потому, что сломан, а потому, что крови на цели не было.
 */
function afflicted(config: Partial<FighterConfig>, status: 'bleed', stacks: number) {
  const state = createFighterState(fighter(config), balance);
  applyStatus(state, 1, status, stacks, 0, balance, createStatusClock());
  return state;
}

/**
 * Мешок, ГАРАНТИРОВАННО носящий щит весь бой.
 *
 * Через `bulwark` не годится: у щита конечная длительность, и в длинном
 * бою он истекает раньше, чем `siphon` успевает бросить свои проценты.
 * Тогда тест падал бы не потому, что трейт сломан, а потому, что срывать
 * было нечего — то есть проверял бы длительность щита, а не срыв.
 */
const shielded = (extra: Array<{ id: 'hex'; stacks: number; duration: number }> = []) =>
  dummy({
    pathBonusHp: 3000,
    statuses: [{ id: 'shield', stacks: 6, duration: -1 }, ...extra],
  });

/** Эффективные статы бойца с набором трейтов против заданного противника. */
function stats(self: Partial<FighterConfig>, opponent: Partial<FighterConfig> = {}) {
  const a = createFighterState(fighter(self), balance);
  const b = createFighterState(fighter(opponent), balance);
  return effectiveStats(a, b, balance);
}

/** Пассив с заранее заведённым состоянием: warlord и innateThief копят стеки. */
function modifiersWithState(
  id: TraitId,
  state: Partial<ReturnType<typeof createTraitState>>,
  self: Partial<FighterConfig> = {},
  opponent: Partial<FighterConfig> = {},
) {
  const a = createFighterState(fighter({ traits: [id], ...self }), balance);
  const b = createFighterState(fighter(opponent), balance);
  a.traitStates.set(id, { ...createTraitState(), ...state });
  return activeTraitModifiers(a, b, balance);
}

/* ───────────────────────── реестр и контракт ─────────────────────────── */

describe('реестр трейтов', () => {
  it('в реестре ровно те трейты, что объявлены в контракте', () => {
    expect([...TRAITS.keys()]).toEqual([...ALL_TRAIT_IDS]);
  });

  it('у каждого трейта есть числа в balance.json', () => {
    const withoutNumbers = ALL_TRAIT_IDS.filter(
      (id) => Object.keys(balance.traits[id] ?? {}).length === 0,
    );
    expect(withoutNumbers, 'трейт без коэффициентов — это трейт в коде').toEqual([]);
  });

  it('каждый трейт что-то делает: есть modify или хотя бы один хук', () => {
    const inert = ALL_TRAIT_IDS.filter((id) => {
      const def = traitDefinition(id);
      return def.modify === undefined && Object.keys(def.hooks).length === 0;
    });
    // innateScholar — единственный, кто работает не хуком и не modify,
    // а прибавкой к длительности при наложении. Он проверен отдельно.
    expect(inert).toEqual(['innateScholar']);
  });

  it('школы распределены, якорные есть в каждой', () => {
    for (const school of ['str', 'def', 'agi', 'mag'] as const) {
      const inSchool = TRAIT_IDS.filter((id) => traitDefinition(id).school === school);
      expect(inSchool.length, `школа ${school} пуста`).toBeGreaterThanOrEqual(7);
      expect(
        inSchool.some((id) => traitDefinition(id).anchor === true),
        `в школе ${school} нет якорного трейта (GDD §4.5)`,
      ).toBe(true);
    }
  });

  it('врождённые трейты не входят в пул выбора', () => {
    for (const id of INNATE_TRAIT_IDS) {
      expect(TRAIT_IDS as readonly string[]).not.toContain(id);
    }
  });

  it('resolve.ts не знает ни одного трейта по имени', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../resolve.ts', import.meta.url), 'utf8');
    const mentioned = ALL_TRAIT_IDS.filter((id) => source.includes(`'${id}'`));
    expect(mentioned, 'цикл боя обязан работать через общие хуки').toEqual([]);
  });
});

/* ─────────────────────────── шесть из аудита ─────────────────────────── */

describe('шесть трейтов из аудита v1.0 делают ровно то, что обещают', () => {
  it('warlord: +3 ATK за победу — и стек действительно копится', () => {
    // Событие в бою: срабатывает на убийстве.
    const { log } = fight(
      striker({ traits: ['warlord'], atk: 60 }),
      dummy({ pathBonusHp: 0, armorClass: 'light' }),
      'warlord',
    );
    expect(fires(log.events, 'warlord', 0)).toHaveLength(1);

    // И сам эффект: стек даёт ровно atkPerKill к ATK, а не «примерно».
    const per = T('warlord', 'atkPerKill');
    expect(modifiersWithState('warlord', { stacks: 0 }).atk).toBe(0);
    expect(modifiersWithState('warlord', { stacks: 2 }).atk).toBe(per * 2);
  });

  it('cursed: урон ×1.4 и доля HP за ход — оба, а не только множитель', () => {
    const mult = T('cursed', 'damageMultiplier');
    const share = T('cursed', 'hpFractionPerTurn');

    // Множитель УРОНА, а не стата ATK (GDD 2.5). Разница не косметическая:
    // урон равен `оружие × (1 + ATK/60)`, поэтому множитель на стате при
    // ATK 50 дал бы +23% урона вместо +40%, и описание разошлось бы
    // с поведением ровно так, как в §13 пункт 4.
    const plain = stats({ atk: 50 });
    const damned = stats({ atk: 50, traits: ['cursed'] });
    expect(damned.outgoingDamageMultiplier).toBeCloseTo(mult, 6);
    expect(damned.atk, 'стат ATK трейт не трогает').toBeCloseTo(plain.atk, 6);

    // Плата HP. В v1.0 её не было вовсе — здесь она в логе числом.
    const carrier = striker({ traits: ['cursed'] });
    const cost = Math.max(1, Math.round(createFighterState(carrier, balance).maxHp * share));
    const { log } = fight(carrier, dummy(), 'cursed');
    const turns = fires(log.events, 'cursed', 0);
    expect(turns.length, 'ни одного хода — платить нечем').toBeGreaterThan(3);

    // Последний ход платит ОСТАТКОМ HP: боец с двумя HP не уходит в минус.
    // Поэтому полная цена проверяется на всех ходах, кроме последнего,
    // а последний — отдельно, как граница.
    for (const e of turns.slice(0, -1)) {
      expect(e.t === 'trait_fire' && e.note).toBe(`hp-${cost}`);
    }
    const last = turns.at(-1);
    const paid = Number(String(last?.t === 'trait_fire' ? last.note : '').replace('hp-', ''));
    expect(paid).toBeGreaterThan(0);
    expect(paid).toBeLessThanOrEqual(cost);

    // Каждой плате соответствует урон по себе в логе — иначе трейт
    // «тратит HP» только в примечании, как в v1.0. Нулевые удары мешка
    // отброшены: у него нет оружия, но ходы есть, и его промахи попали бы
    // в ту же выборку.
    const selfHits = log.events.filter((e) => e.t === 'damage' && e.target === 0 && e.amount > 0);
    expect(selfHits.length).toBe(turns.length);
  });

  it('cursed: плата МАСШТАБИРУЕТСЯ — вдвое больше HP значит вдвое больше платы', () => {
    // Ради этого плоское число и заменено долей (GDD 2.5): на первом
    // уровне три HP были половиной исхода боя, на сороковом — ничем.
    const share = T('cursed', 'hpFractionPerTurn');
    const paid = (bonusHp: number) => {
      const carrier = striker({ traits: ['cursed'], pathBonusHp: bonusHp });
      const { log } = fight(carrier, dummy({ pathBonusHp: 4000 }), 'cursed-scale');
      const first = fires(log.events, 'cursed', 0)[0];
      return {
        note: Number(String(first?.t === 'trait_fire' ? first.note : '').replace('hp-', '')),
        maxHp: createFighterState(carrier, balance).maxHp,
      };
    };

    const small = paid(0);
    const large = paid(small.maxHp);

    expect(large.maxHp).toBe(small.maxHp * 2);
    expect(small.note).toBe(Math.max(1, Math.round(small.maxHp * share)));
    expect(large.note).toBe(Math.max(1, Math.round(large.maxHp * share)));
    // И это РАЗНЫЕ числа: при плоской плате обе строки совпали бы,
    // и тест прошёл бы, не заметив, что масштабирования нет.
    expect(large.note).toBeGreaterThan(small.note);
  });

  it('thorns: потолок отражения за удар держит сильный удар', () => {
    const frac = T('thorns', 'reflectFraction');
    const cap = T('thorns', 'maxReflectPerHit');

    // Удар, у которого доля ЗАВЕДОМО выше потолка. На первом уровне такого
    // не бывает — потолок и заведён не для сейчас, а для прогрессии, —
    // поэтому проверяется он прямым вызовом хука, а не боем.
    const huge = Math.ceil((cap / frac) * 3);
    expect(huge * frac, 'удар слабее потолка — потолок проверять нечем').toBeGreaterThan(cap);

    const self = createFighterState(fighter({ traits: ['thorns'] }), balance);
    const foe = createFighterState(fighter({ pathBonusHp: 5000 }), balance);
    const before = foe.hp;

    traitDefinition('thorns').hooks.onTakeDamage!({
      self,
      selfIndex: 0,
      opponent: foe,
      opponentIndex: 1,
      balance,
      rng: { next: () => 0, chance: () => false, int: () => 0 } as never,
      clock: createStatusClock(),
      state: createTraitState(),
      amount: huge,
    });

    expect(before - foe.hp).toBe(Math.round(cap));

    // А удар НИЖЕ потолка отражается долей, а не потолком — иначе трейт
    // превратился бы в «всегда столько-то», и доля перестала бы значить.
    const smallHit = Math.floor(cap / frac / 3);
    const foe2 = createFighterState(fighter({ pathBonusHp: 5000 }), balance);
    const before2 = foe2.hp;
    traitDefinition('thorns').hooks.onTakeDamage!({
      self,
      selfIndex: 0,
      opponent: foe2,
      opponentIndex: 1,
      balance,
      rng: { next: () => 0, chance: () => false, int: () => 0 } as never,
      clock: createStatusClock(),
      state: createTraitState(),
      amount: smallHit,
    });
    expect(before2 - foe2.hp).toBe(Math.round(smallHit * frac));
    expect(before2 - foe2.hp).toBeLessThan(cap);
  });

  it('slippery: режет и крит противника, и входящий урон', () => {
    const reduction = T('slippery', 'incomingReduction');
    const critMult = T('slippery', 'enemyCritMultiplier');
    const passive = stats({ traits: ['slippery'] });

    expect(passive.enemyCritMultiplier).toBe(critMult);
    expect(passive.incomingDamageMultiplier).toBeCloseTo(1 - reduction, 6);

    // Оба эффекта нужны: множителя крита одного не хватало до уровня
    // школы, это замерено матрицей §4.6 (GDD 2.5). Проверяем, что второй
    // действительно доходит до урона, а не остаётся в статах.
    //
    // Сравнивается СРЕДНИЙ УРОН ЗА УДАР по многим боям. Два тупика,
    // в которые этот тест успел попасть, стоят того, чтобы их назвать:
    //
    //  - на ОДНОМ ударе четыре процента меньше шага округления: 16.4
    //    и 15.7 дают одно и то же целое. Хуже того, у обвязки оружие
    //    бьёт фиксированные 10, поэтому одинаково округляется КАЖДЫЙ
    //    удар во всех боях сразу — тест был бы зелёным при полностью
    //    отключённом множителе. Отсюда оружие с разбросом ниже.
    //  - СУММА урона за бой не годится тем более: она упирается в запас
    //    HP цели и потому одинакова при любом множителе. Слабее бьёшь —
    //    дольше бьёшь, итог тот же.
    const attacker = striker({
      atk: 30,
      agi: 0,
      critBonus: -1,
      weapon: { dmgMin: 8, dmgMax: 14, ilvl: 1, class: 'balanced' },
    });

    const perHit = (traits: TraitId[]) => {
      let total = 0;
      let hits = 0;
      for (let i = 0; i < 40; i++) {
        const { log } = resolveBattle(
          [attacker, dummy({ pathBonusHp: 4000, traits })] as BattleSetup,
          balance,
          `slippery-dmg-${i}`,
        );
        for (const e of log.events) {
          if (e.t !== 'damage' || e.target !== 1 || e.amount <= 0) continue;
          total += e.amount;
          hits++;
        }
      }
      return { avg: total / hits, hits };
    };

    const plain = perHit([]);
    const slick = perHit(['slippery']);

    expect(plain.hits, 'ударов не было — сравнивать нечего').toBeGreaterThan(1000);
    expect(slick.avg).toBeLessThan(plain.avg);
    expect(slick.avg / plain.avg).toBeCloseTo(1 - reduction, 2);
  });

  it('fortress: блок гасит урон полностью', () => {
    const offhand = { kind: 'shield', blockChance: 1, blockReduction: 0.22 } as const;
    const setup: BattleSetup = [
      striker({ atk: 40 }),
      dummy({ offhand, traits: ['fortress'], pathBonusHp: 2000 }),
    ];
    const { log } = resolveBattle(setup, balance, 'fortress');

    const hits = log.events.filter((e) => e.t === 'damage' && e.target === 1);
    expect(hits.length, 'ударов не было — тест ничего не доказал бы').toBeGreaterThan(3);
    for (const e of hits) expect(e.t === 'damage' && e.amount).toBe(0);

    // Контроль: без трейта тот же щит с тем же сидом урон пропускает.
    const без = resolveBattle(
      [striker({ atk: 40 }), dummy({ offhand, pathBonusHp: 2000 })] as BattleSetup,
      balance,
      'fortress',
    );
    const passed = без.log.events.filter((e) => e.t === 'damage' && e.target === 1 && e.amount > 0);
    expect(passed.length, 'щит без трейта обязан пропускать урон').toBeGreaterThan(0);
  });

  it('thorns: отражает ровно 15% полученного урона', () => {
    const frac = T('thorns', 'reflectFraction');
    const setup: BattleSetup = [
      striker({ atk: 40, pathBonusHp: 2000 }),
      dummy({ traits: ['thorns'], pathBonusHp: 2000 }),
    ];
    const { log } = resolveBattle(setup, balance, 'thorns');

    // Каждому урону по защитнику соответствует отражение той же доли.
    const pairs: Array<{ incoming: number; reflected: number }> = [];
    for (let i = 0; i < log.events.length; i++) {
      const e = log.events[i];
      if (e?.t !== 'damage' || e.target !== 1 || e.amount <= 0) continue;
      const back = log.events[i + 2];
      if (back?.t !== 'damage' || back.target !== 0) continue;
      pairs.push({ incoming: e.amount, reflected: back.amount });
    }

    expect(pairs.length, 'отражений не было — проверять нечего').toBeGreaterThan(2);
    for (const { incoming, reflected } of pairs) {
      expect(reflected).toBe(Math.round(incoming * frac));
    }
  });

  it('phantom: 10% полностью избежать удара, отдельным броском', () => {
    const chance = T('phantom', 'avoidChance');
    expect(stats({ traits: ['phantom'] }).avoidChance).toBe(chance);

    // Статистика по многим боям: доля избеганий совпадает с числом,
    // а без трейта при той же точности их нет ни одного.
    let avoided = 0;
    let attacks = 0;
    let baseline = 0;
    for (let i = 0; i < 200; i++) {
      const seed = `phantom-${i}`;
      const withTrait = resolveBattle(
        [striker({ atk: 5 }), dummy({ traits: ['phantom'], pathBonusHp: 3000 })] as BattleSetup,
        balance,
        seed,
      );
      const without = resolveBattle(
        [striker({ atk: 5 }), dummy({ pathBonusHp: 3000 })] as BattleSetup,
        balance,
        seed,
      );
      // Уклонения считаются ТОЛЬКО у защитника: мешок тоже бьёт, и его
      // промахи по атакующему попали бы в ту же выборку, размыв долю.
      avoided += withTrait.log.events.filter((e) => e.t === 'dodge' && e.actor === 1).length;
      attacks += withTrait.log.events.filter((e) => e.t === 'turn_start' && e.actor === 0).length;
      baseline += without.log.events.filter((e) => e.t === 'dodge' && e.actor === 1).length;
    }

    expect(attacks).toBeGreaterThan(1000);
    // Точность 500 против AGI 0 упирает уклонение в нижний кап — значит
    // всё, что осталось, пришло с шага 0, а не со шага 1.
    expect(baseline, 'обычное уклонение живо — доля избеганий не чистая').toBe(0);
    expect(avoided / attacks).toBeCloseTo(chance, 2);
  });

  it('hexblade: 20% наложить хекс, и хекс действительно режет ATK', () => {
    const chance = T('hexblade', 'chance');
    let hexes = 0;
    let hits = 0;
    for (let i = 0; i < 200; i++) {
      const { log } = fight(
        striker({ traits: ['hexblade'], atk: 5 }),
        dummy({ pathBonusHp: 3000 }),
        `hexblade-${i}`,
      );
      hits += log.events.filter((e) => e.t === 'damage' && e.target === 1).length;
      hexes += fires(log.events, 'hexblade', 0).length;
    }

    expect(hits).toBeGreaterThan(1000);
    expect(hexes / hits).toBeCloseTo(chance, 2);

    // И сам хекс не декоративен: ATK цели падает на число из данных.
    const victim = createFighterState(fighter({ atk: 50 }), balance);
    const before = effectiveStats(victim, createFighterState(fighter(), balance), balance).atk;
    applyStatus(victim, 1, 'hex', 1, 0, balance, createStatusClock());
    const after = effectiveStats(victim, createFighterState(fighter(), balance), balance).atk;
    expect(after).toBe(before + balance.statuses.hex.atkPerStack);
    expect(after).toBeLessThan(before);
  });
});

/* ────────────────────── каждый трейт наблюдаем ───────────────────────── */

describe('каждый трейт наблюдаем', () => {
  /**
   * Сценарий на трейт: бой, в котором он ОБЯЗАН сработать, и признак,
   * по которому это видно. Пассивы, не дающие события, проверяются
   * через эффективные статы — там их эффект тоже число, а не факт.
   */
  const observable: Record<TraitId, () => boolean> = {
    warlord: () =>
      fires(
        fight(striker({ traits: ['warlord'], atk: 60 }), dummy({ pathBonusHp: 0 }), 'o').log.events,
        'warlord',
      ).length > 0,
    cursed: () =>
      fires(fight(striker({ traits: ['cursed'] }), dummy(), 'o').log.events, 'cursed').length > 0,
    executioner: () =>
      effectiveStats(
        createFighterState(fighter({ traits: ['executioner'] }), balance),
        hurt({}, T('executioner', 'hpThreshold') / 2),
        balance,
      ).outgoingDamageMultiplier > 1,
    bloodlust: () =>
      applies(fight(striker({ traits: ['bloodlust'] }), dummy(), 'o').log.events, 'bleed', 1)
        .length > 0,
    berserker: () =>
      effectiveStats(
        hurt({ traits: ['berserker'] }, 0.2),
        createFighterState(fighter(), balance),
        balance,
      ).outgoingDamageMultiplier > 1,
    // Крит вызывается прямым бонусом, а не подстроенной связкой
    // с `innateAdvocate` на одном сиде: та зависела от того, случится ли
    // уклонение именно в этом бою, и развалилась, как только поток
    // генератора сдвинулся от правки в шаге 0 пайплайна.
    overpower: () =>
      applies(
        fight(striker({ traits: ['overpower'], critBonus: 1 }), dummy({ pathBonusHp: 2000 }), 'o')
          .log.events,
        'stun',
        1,
      ).length > 0,
    ironGrip: () => stats({ traits: ['ironGrip'] }).armorPenetration > 0,
    butcher: () =>
      effectiveStats(
        createFighterState(fighter({ traits: ['butcher'] }), balance),
        afflicted({}, 'bleed', 1),
        balance,
      ).outgoingDamageMultiplier > 1,
    fortress: () => stats({ traits: ['fortress'] }).blockReductionOverride !== undefined,
    thorns: () =>
      fires(
        resolveBattle(
          [
            striker({ atk: 40, pathBonusHp: 2000 }),
            dummy({ traits: ['thorns'], pathBonusHp: 2000 }),
          ] as BattleSetup,
          balance,
          'o',
        ).log.events,
        'thorns',
      ).length > 0,
    secondWind: () =>
      fires(
        fight(striker({ atk: 60 }), dummy({ traits: ['secondWind'], pathBonusHp: 0 }), 'o').log
          .events,
        'secondWind',
      ).length > 0,
    bulwark: () =>
      fires(fight(striker({ traits: ['bulwark'] }), dummy(), 'o').log.events, 'bulwark').length > 0,
    stoneskin: () => stats({ traits: ['stoneskin'], armor: 10 }).armor > stats({ armor: 10 }).armor,
    retribution: () =>
      applies(
        resolveBattle(
          [
            striker({ atk: 40, critBonus: 1, pathBonusHp: 2000 }),
            dummy({ traits: ['retribution'], pathBonusHp: 2000 }),
          ] as BattleSetup,
          balance,
          'o',
        ).log.events,
        'burn',
        0,
      ).length > 0,
    hardened: () => stats({ traits: ['hardened'] }).armor > stats({}).armor,
    resolve: () =>
      fires(
        fight(
          striker({ traits: ['resolve'], statuses: [{ id: 'stun', stacks: 1, duration: 8 }] }),
          dummy(),
          'o',
        ).log.events,
        'resolve',
      ).length > 0,
    phantom: () => stats({ traits: ['phantom'] }).avoidChance > 0,
    windup: () =>
      modifiersWithState('windup', { turns: T('windup', 'everyNTurns') }).outgoingDamageMultiplier >
      1,
    riposte: () =>
      applies(
        fight(
          striker({ atk: 5, accuracy: 0, pathBonusHp: 3000 }),
          dummy({ agi: 200, traits: ['riposte'], pathBonusHp: 3000 }),
          'o',
        ).log.events,
        'bleed',
        0,
      ).length > 0,
    quickstep: () => stats({ traits: ['quickstep'] }).spd > stats({}).spd,
    deadeye: () => stats({ traits: ['deadeye'] }).accuracy > stats({}).accuracy,
    bleedout: () =>
      applies(
        fight(striker({ traits: ['bleedout'], critBonus: 1 }), dummy({ pathBonusHp: 2000 }), 'o')
          .log.events,
        'bleed',
        1,
      ).length > 0,
    slippery: () => stats({ traits: ['slippery'] }).enemyCritMultiplier < 1,
    hexblade: () =>
      applies(
        fight(striker({ traits: ['hexblade'], atk: 5 }), dummy({ pathBonusHp: 3000 }), 'o').log
          .events,
        'hex',
        1,
      ).length > 0,
    plaguebearer: () =>
      applies(fight(striker({ traits: ['plaguebearer'] }), dummy(), 'o').log.events, 'poison', 1)
        .length > 0,
    amplifier: () => stats({ traits: ['amplifier'] }).dotDamageBonus > 0,
    pyromancer: () =>
      applies(
        fight(striker({ traits: ['pyromancer'], critBonus: 1 }), dummy({ pathBonusHp: 2000 }), 'o')
          .log.events,
        'burn',
        1,
      ).length > 0,
    leech: () =>
      fires(
        resolveBattle(
          [
            striker({
              traits: ['leech'],
              atk: 40,
              pathBonusHp: 400,
              statuses: [{ id: 'bleed', stacks: 5, duration: 40 }],
            }),
            dummy({ pathBonusHp: 2000 }),
          ] as BattleSetup,
          balance,
          'o',
        ).log.events,
        'leech',
      ).length > 0,
    frostbite: () =>
      applies(fight(striker({ traits: ['frostbite'] }), dummy(), 'o').log.events, 'chill', 1)
        .length > 0,
    siphon: () => {
      for (let i = 0; i < 60; i++) {
        const { log } = fight(striker({ traits: ['siphon'], atk: 5 }), shielded(), `siphon-${i}`);
        if (fires(log.events, 'siphon').length > 0) return true;
      }
      return false;
    },
    innateThief: () =>
      modifiersWithState('innateThief', { stacks: 3 }).outgoingDamageMultiplier > 1,
    innateGuard: () => stats({ traits: ['innateGuard'] }).incomingDamageMultiplier < 1,
    innateAdvocate: () =>
      modifiersWithState('innateAdvocate', { armed: true }).guaranteedCrit === true &&
      modifiersWithState('innateAdvocate', { armed: false }).guaranteedCrit === false,
    innateScholar: () => {
      const clock = createStatusClock();
      const caster = createFighterState(fighter({ traits: ['innateScholar'] }), balance);
      const victim = createFighterState(fighter(), balance);
      const plain = createFighterState(fighter(), balance);
      applyStatus(victim, 1, 'poison', 1, 0, balance, clock, {
        dotDamageBonus: 0,
        durationBonus: T('innateScholar', 'extraDuration'),
      });
      applyStatus(plain, 1, 'poison', 1, 0, balance, clock);
      void caster;
      return (victim.statuses[0]?.duration ?? 0) > (plain.statuses[0]?.duration ?? 0);
    },

    /* Трейты монстров (§7.5). Наблюдаемость доказывается тем же
       способом, что у остальных: событием в логе, а не рассуждением. */
    bossEnrage: () => {
      // Боец, начинающий бой уже раненым ниже порога: иначе «вошёл
      // в ярость» проверялось бы на бое, где порог не пересекается.
      const boss = striker({
        traits: ['bossEnrage'],
        atk: 3,
        // Кровотечение на САМОМ боссе доводит его до порога, а мешок
        // с большим запасом HP не даёт бою кончиться раньше.
        statuses: [{ id: 'bleed', stacks: 9, duration: 400 }],
      });
      const { log } = fight(boss, dummy({ pathBonusHp: 6000 }), 'enrage');
      return (
        fires(log.events, 'bossEnrage', 0).length > 0 && applies(log.events, 'enrage', 0).length > 0
      );
    },
    bossHeavyStrike: () => {
      const { log } = fight(
        striker({ traits: ['bossHeavyStrike'], atk: 5 }),
        dummy({ pathBonusHp: 3000 }),
        'heavy',
      );
      return log.events.some((e) => e.t === 'telegraph');
    },
  };

  it.each(ALL_TRAIT_IDS)('%s наблюдаем', (id) => {
    expect(observable[id](), `трейт «${id}» не наблюдаем: он есть в описании и нет в бою`).toBe(
      true,
    );
  });
});

/* ───────────────────── что именно делает каждый ──────────────────────── */

describe('STR', () => {
  it('executioner усиливает урон только по цели ниже порога', () => {
    const threshold = T('executioner', 'hpThreshold');
    const mult = T('executioner', 'damageMultiplier');

    const healthy = stats({ traits: ['executioner'] }, { pathBonusHp: 100 });
    expect(healthy.outgoingDamageMultiplier).toBe(1);

    const wounded = createFighterState(fighter({ pathBonusHp: 100 }), balance);
    wounded.hp = Math.floor(wounded.maxHp * threshold);
    const self = createFighterState(fighter({ traits: ['executioner'] }), balance);
    expect(effectiveStats(self, wounded, balance).outgoingDamageMultiplier).toBe(mult);
  });

  it('bloodlust вызывает кровотечение с заявленным шансом', () => {
    const chance = T('bloodlust', 'chance');
    const stacks = T('bloodlust', 'bleedStacks');

    let hits = 0;
    let bleeds = 0;
    let firstStacks = 0;
    for (let i = 0; i < 200; i++) {
      const { log } = fight(
        striker({ traits: ['bloodlust'], atk: 5 }),
        dummy({ pathBonusHp: 3000 }),
        `bloodlust-${i}`,
      );
      // Смертельный удар статус не вешает: `inflict` не трогает труп.
      hits += log.events.filter((e) => e.t === 'damage' && e.target === 1 && e.hpAfter > 0).length;
      const applied = fires(log.events, 'bloodlust', 0);
      bleeds += applied.length;
      const first = applies(log.events, 'bleed', 1)[0];
      if (firstStacks === 0 && first?.t === 'status_apply') firstStacks = first.stacks;
    }

    expect(hits).toBeGreaterThan(1000);
    expect(bleeds / hits).toBeCloseTo(chance, 2);
    expect(firstStacks).toBe(stacks);
  });

  it('berserker растёт линейно к нулю HP и равен единице на полном', () => {
    const max = T('berserker', 'maxBonus');
    const self = createFighterState(fighter({ traits: ['berserker'], pathBonusHp: 100 }), balance);
    const foe = createFighterState(fighter(), balance);

    expect(effectiveStats(self, foe, balance).outgoingDamageMultiplier).toBeCloseTo(1, 6);
    self.hp = self.maxHp / 2;
    expect(effectiveStats(self, foe, balance).outgoingDamageMultiplier).toBeCloseTo(1 + max / 2, 6);
    self.hp = 0;
    expect(effectiveStats(self, foe, balance).outgoingDamageMultiplier).toBeCloseTo(1 + max, 6);
  });

  it('overpower станит на крите и только на крите', () => {
    const withCrit = fight(
      striker({ traits: ['overpower'], critBonus: 1 }),
      dummy({ pathBonusHp: 2000 }),
      'overpower',
    );
    const crits = withCrit.log.events.filter((e) => e.t === 'damage' && e.crit === true);
    expect(crits.length, 'критов не было — «только на крите» недоказуемо').toBeGreaterThan(2);
    expect(fires(withCrit.log.events, 'overpower').length).toBe(crits.length);

    const noCrit = fight(
      striker({ traits: ['overpower'], critBonus: -1, agi: 0 }),
      dummy({ pathBonusHp: 2000 }),
      'overpower',
    );
    const plainHits = noCrit.log.events.filter((e) => e.t === 'damage' && e.target === 1);
    expect(plainHits.length, 'ударов не было — тест пуст').toBeGreaterThan(3);
    expect(plainHits.every((e) => e.t === 'damage' && e.crit === false)).toBe(true);
    expect(fires(noCrit.log.events, 'overpower')).toEqual([]);
  });

  it('ironGrip игнорирует ровно заявленную долю брони', () => {
    const pen = T('ironGrip', 'armorPenetration');
    expect(stats({ traits: ['ironGrip'] }).armorPenetration).toBe(pen);

    // И это видно в разборе броска: митигация падает.
    const armored = dummy({ armor: 60, pathBonusHp: 2000 });
    const plain = resolveBattle([striker({ atk: 30 }), armored] as BattleSetup, balance, 'grip');
    const gripped = resolveBattle(
      [striker({ atk: 30, traits: ['ironGrip'] }), armored] as BattleSetup,
      balance,
      'grip',
    );
    const dr = (r: ReturnType<typeof resolveBattle>) => {
      const e = r.log.events.find((x) => x.t === 'attack');
      return e?.t === 'attack' ? e.roll.mitigation : NaN;
    };
    expect(dr(plain)).toBeGreaterThan(0);
    expect(dr(gripped)).toBeLessThan(dr(plain));
  });

  it('butcher бьёт сильнее только по истекающему кровью', () => {
    const bonus = T('butcher', 'damageBonusVsBleeding');
    const self = createFighterState(fighter({ traits: ['butcher'] }), balance);

    expect(
      effectiveStats(self, createFighterState(fighter(), balance), balance)
        .outgoingDamageMultiplier,
    ).toBe(1);
    expect(
      effectiveStats(self, afflicted({}, 'bleed', 1), balance).outgoingDamageMultiplier,
    ).toBeCloseTo(1 + bonus, 6);
  });
});

describe('DEF', () => {
  it('secondWind срабатывает один раз за бой и только ниже порога', () => {
    const { log } = fight(
      striker({ atk: 25 }),
      dummy({ traits: ['secondWind'], pathBonusHp: 200 }),
      'second-wind',
    );
    const fired = fires(log.events, 'secondWind', 1);
    expect(fired.length, 'ни разу не сработал — порог недостижим в этом бою').toBe(1);

    // Момент срабатывания: HP уже ниже порога, а до него их было больше.
    const idx = log.events.indexOf(fired[0] as BattleEvent);
    const hpBefore = log.events
      .slice(0, idx)
      .filter((e) => e.t === 'damage' && e.target === 1)
      .map((e) => (e.t === 'damage' ? e.hpAfter : 0));
    const maxHp = createFighterState(
      dummy({ traits: ['secondWind'], pathBonusHp: 200 }),
      balance,
    ).maxHp;
    expect(hpBefore.at(-1)! / maxHp).toBeLessThanOrEqual(T('secondWind', 'hpThreshold'));
    expect(hpBefore[0]! / maxHp).toBeGreaterThan(T('secondWind', 'hpThreshold'));

    expect(applies(log.events, 'regen', 1).length).toBe(1);
  });

  it('bulwark даёт щит на входе в бой, до первого удара', () => {
    const { log } = fight(striker({ traits: ['bulwark'] }), dummy(), 'bulwark');
    const shield = applies(log.events, 'shield', 0)[0];
    expect(shield?.t === 'status_apply' && shield.stacks).toBe(T('bulwark', 'shieldStacks'));

    const firstTurn = log.events.findIndex((e) => e.t === 'turn_start');
    expect(log.events.indexOf(shield as BattleEvent)).toBeLessThan(firstTurn);
  });

  it('stoneskin усиливает броню только выше порога HP', () => {
    const mult = T('stoneskin', 'armorMultiplier');
    const self = createFighterState(
      fighter({ traits: ['stoneskin'], armor: 20, pathBonusHp: 100 }),
      balance,
    );
    const foe = createFighterState(fighter(), balance);

    expect(effectiveStats(self, foe, balance).armor).toBeCloseTo(20 * mult, 6);
    self.hp = Math.floor(self.maxHp * T('stoneskin', 'hpThreshold'));
    expect(effectiveStats(self, foe, balance).armor).toBeCloseTo(20, 6);
  });

  it('retribution поджигает в ответ на крит и только на него', () => {
    const crit = resolveBattle(
      [
        striker({ atk: 30, critBonus: 1, pathBonusHp: 2000 }),
        dummy({ traits: ['retribution'], pathBonusHp: 2000 }),
      ] as BattleSetup,
      balance,
      'retribution',
    );
    const crits = crit.log.events.filter((e) => e.t === 'damage' && e.target === 1 && e.crit);
    expect(crits.length).toBeGreaterThan(2);
    expect(fires(crit.log.events, 'retribution').length).toBe(crits.length);
    expect(
      applies(crit.log.events, 'burn', 0)[0]?.t === 'status_apply' &&
        applies(crit.log.events, 'burn', 0)[0]?.stacks,
    ).toBe(T('retribution', 'burnStacks'));

    const noCrit = resolveBattle(
      [
        striker({ atk: 30, critBonus: -1, agi: 0, pathBonusHp: 2000 }),
        dummy({ traits: ['retribution'], pathBonusHp: 2000 }),
      ] as BattleSetup,
      balance,
      'retribution',
    );
    const hits = noCrit.log.events.filter((e) => e.t === 'damage' && e.target === 1);
    expect(hits.length, 'без ударов «только на крите» недоказуемо').toBeGreaterThan(3);
    expect(fires(noCrit.log.events, 'retribution')).toEqual([]);
  });

  it('hardened даёт ровно заявленную броню', () => {
    expect(stats({ traits: ['hardened'], armor: 5 }).armor).toBe(5 + T('hardened', 'armor'));
  });

  it('resolve сокращает стан вдвое, и стан при этом был', () => {
    const factor = T('resolve', 'stunDurationMultiplier');

    // Точная арифметика — на хуке: к моменту, когда боец получает ход,
    // длительность уже успела убыть тиками, и «8 → 4» в бою не сойдётся
    // не из-за трейта.
    const self = createFighterState(fighter({ traits: ['resolve'] }), balance);
    applyStatus(self, 0, 'stun', 1, 8, balance, createStatusClock());
    expect(self.statuses[0]?.duration, 'стана нет — сокращать нечего').toBe(8);

    const events = traitDefinition('resolve').hooks.onTurnStart!({
      self,
      selfIndex: 0,
      opponent: createFighterState(fighter(), balance),
      opponentIndex: 1,
      balance,
      rng: { next: () => 0, chance: () => false, int: () => 0 } as never,
      clock: createStatusClock(),
      state: createTraitState(),
    });
    expect(self.statuses[0]?.duration).toBe(Math.floor(8 * factor));
    expect(events[0]?.t === 'trait_fire' && events[0].note).toBe(`stun→${Math.floor(8 * factor)}`);

    // И в настоящем бою он тоже срабатывает, а не только на стенде.
    const { log } = fight(
      striker({ traits: ['resolve'], statuses: [{ id: 'stun', stacks: 1, duration: 8 }] }),
      dummy(),
      'resolve',
    );
    expect(fires(log.events, 'resolve', 0).length).toBeGreaterThan(0);
  });
});

describe('AGI', () => {
  it('windup усиливает каждый третий ход, а не каждый', () => {
    const every = T('windup', 'everyNTurns');
    const mult = T('windup', 'damageMultiplier');
    for (let turns = 1; turns <= every * 2; turns++) {
      const m = modifiersWithState('windup', { turns }).outgoingDamageMultiplier;
      expect(m, `ход ${turns}`).toBeCloseTo(turns % every === 0 ? mult : 1, 6);
    }
  });

  it('riposte отвечает кровотечением на уклонение, а не на удар', () => {
    const { log } = fight(
      striker({ atk: 5, accuracy: 0, pathBonusHp: 3000 }),
      dummy({ agi: 200, traits: ['riposte'], pathBonusHp: 3000 }),
      'riposte',
    );
    // Уклонения защитника, а не свои: мешок тоже атакует.
    const dodges = log.events.filter((e) => e.t === 'dodge' && e.actor === 1);
    const bleeds = applies(log.events, 'bleed', 0);
    const hits = log.events.filter((e) => e.t === 'damage' && e.target === 1 && e.hpAfter > 0);

    expect(dodges.length, 'уклонений не было').toBeGreaterThan(3);
    expect(hits.length, 'попаданий тоже не было — «не на удар» недоказуемо').toBeGreaterThan(0);
    expect(bleeds.length).toBe(dodges.length);
    expect(bleeds[0]?.t === 'status_apply' && bleeds[0].stacks).toBe(T('riposte', 'bleedStacks'));
  });

  it('quickstep ускоряет ровно на заявленный множитель', () => {
    const mult = T('quickstep', 'spdMultiplier');
    expect(stats({ traits: ['quickstep'], spd: 20 }).spd).toBeCloseTo(20 * mult, 6);
  });

  it('deadeye поднимает точность и тем снижает уклонение цели', () => {
    expect(stats({ traits: ['deadeye'] }).accuracy).toBe(T('deadeye', 'accuracy'));

    // AGI цели подобран так, чтобы уклонение НЕ упиралось в кап 30%:
    // на AGI 60 оно и без точности стоит в кап, и восемь единиц ACC
    // ничего не меняют — тест был бы зелёным при сломанном трейте.
    const agi = 25;
    const raw = balance.dodge.base + agi * balance.dodge.perAgiOverAccuracy;
    expect(raw, 'уклонение упёрлось в кап — точность не проявится').toBeLessThan(balance.dodge.max);

    let plain = 0;
    let sharp = 0;
    for (let i = 0; i < 60; i++) {
      const foe = dummy({ agi, pathBonusHp: 3000 });
      const dodgesOfDefender = (r: ReturnType<typeof resolveBattle>) =>
        r.log.events.filter((e) => e.t === 'dodge' && e.actor === 1).length;
      plain += dodgesOfDefender(
        resolveBattle(
          [striker({ atk: 1, accuracy: 0 }), foe] as BattleSetup,
          balance,
          `deadeye-${i}`,
        ),
      );
      sharp += dodgesOfDefender(
        resolveBattle(
          [striker({ atk: 1, accuracy: 0, traits: ['deadeye'] }), foe] as BattleSetup,
          balance,
          `deadeye-${i}`,
        ),
      );
    }
    expect(plain, 'уклонений не было вовсе — снижать нечего').toBeGreaterThan(50);
    expect(sharp).toBeLessThan(plain);
  });

  it('bleedout вешает кровотечение на крите и только на нём', () => {
    const yes = fight(
      striker({ traits: ['bleedout'], critBonus: 1 }),
      dummy({ pathBonusHp: 2000 }),
      'bleedout',
    );
    const crits = yes.log.events.filter((e) => e.t === 'damage' && e.target === 1 && e.crit);
    expect(crits.length).toBeGreaterThan(2);
    expect(fires(yes.log.events, 'bleedout').length).toBe(crits.length);

    const no = fight(
      striker({ traits: ['bleedout'], critBonus: -1, agi: 0 }),
      dummy({ pathBonusHp: 2000 }),
      'bleedout',
    );
    expect(no.log.events.filter((e) => e.t === 'damage' && e.target === 1).length).toBeGreaterThan(
      3,
    );
    expect(fires(no.log.events, 'bleedout')).toEqual([]);
  });

  it('slippery режет шанс крита ПРОТИВНИКА, и криты в контроле были', () => {
    const mult = T('slippery', 'enemyCritMultiplier');
    expect(stats({ traits: ['slippery'] }).enemyCritMultiplier).toBe(mult);

    let plain = 0;
    let slick = 0;
    let attacks = 0;
    for (let i = 0; i < 120; i++) {
      const seed = `slippery-${i}`;
      const a = striker({ atk: 1, agi: 40 });
      const p = resolveBattle([a, dummy({ pathBonusHp: 3000 })] as BattleSetup, balance, seed);
      const s = resolveBattle(
        [a, dummy({ pathBonusHp: 3000, traits: ['slippery'] })] as BattleSetup,
        balance,
        seed,
      );
      plain += p.log.events.filter((e) => e.t === 'damage' && e.crit).length;
      slick += s.log.events.filter((e) => e.t === 'damage' && e.crit).length;
      attacks += p.log.events.filter((e) => e.t === 'damage' && e.target === 1).length;
    }

    expect(attacks).toBeGreaterThan(500);
    expect(plain / attacks, 'критов не было — резать нечего').toBeGreaterThan(0.05);
    expect(slick / plain).toBeCloseTo(mult, 1);
  });
});

describe('MAG', () => {
  it('plaguebearer травит с заявленным шансом', () => {
    const chance = T('plaguebearer', 'chance');
    let hits = 0;
    let poisons = 0;
    for (let i = 0; i < 200; i++) {
      const { log } = fight(
        striker({ traits: ['plaguebearer'], atk: 5 }),
        dummy({ pathBonusHp: 3000 }),
        `plague-${i}`,
      );
      hits += log.events.filter((e) => e.t === 'damage' && e.target === 1 && e.hpAfter > 0).length;
      poisons += fires(log.events, 'plaguebearer', 0).length;
    }

    expect(hits).toBeGreaterThan(1000);
    expect(poisons / hits).toBeCloseTo(chance, 2);
  });

  it('amplifier усиливает СВОИ эффекты и не усиливает чужие', () => {
    const bonus = T('amplifier', 'dotDamageBonus');
    const perStack = balance.statuses.poison.damagePerStack;

    // Свой яд — сильнее ровно на заявленную долю.
    const victim = createFighterState(fighter({ pathBonusHp: 2000 }), balance);
    applyStatus(victim, 1, 'poison', 2, 5, balance, createStatusClock(), {
      dotDamageBonus: bonus,
      durationBonus: 0,
    });
    const boosted = tickFighterStatuses(victim, 1, balance, STATUS_ORDER);
    expect(boosted.damage).toBe(Math.round(perStack * 2 * (1 + bonus)));

    // Чужой (нейтральный источник) — без прибавки.
    const other = createFighterState(fighter({ pathBonusHp: 2000 }), balance);
    applyStatus(other, 1, 'poison', 2, 5, balance, createStatusClock());
    expect(tickFighterStatuses(other, 1, balance, STATUS_ORDER).damage).toBe(perStack * 2);

    // И это разные числа — иначе проверка выше ничего не значит.
    expect(boosted.damage).toBeGreaterThan(perStack * 2);

    // Лечение источник не усиливает: бонус принадлежит накладывающему,
    // а регенерацию врагу он не вешает.
    const healer = createFighterState(fighter({ pathBonusHp: 2000 }), balance);
    healer.hp = 1;
    applyStatus(healer, 0, 'regen', 2, 5, balance, createStatusClock(), {
      dotDamageBonus: bonus,
      durationBonus: 0,
    });
    tickFighterStatuses(healer, 0, balance, STATUS_ORDER);
    expect(healer.hp).toBe(1 + balance.statuses.regen.healPerStack * 2);
  });

  it('amplifier усиливает яд плагоносца в настоящем бою', () => {
    const seed = 'amp-fight';
    const foe = () => dummy({ pathBonusHp: 3000 });
    const plain = resolveBattle(
      [striker({ traits: ['plaguebearer'], atk: 1 }), foe()] as BattleSetup,
      balance,
      seed,
    );
    const amped = resolveBattle(
      [striker({ traits: ['plaguebearer', 'amplifier'], atk: 1 }), foe()] as BattleSetup,
      balance,
      seed,
    );
    const poisonDamage = (r: typeof plain) =>
      r.log.events
        .filter((e) => e.t === 'status_tick' && e.status === 'poison')
        .reduce((sum, e) => sum + (e.t === 'status_tick' ? e.amount : 0), 0);

    expect(poisonDamage(plain), 'яда не было — усиливать нечего').toBeGreaterThan(0);
    expect(poisonDamage(amped)).toBeGreaterThan(poisonDamage(plain));
  });

  it('pyromancer поджигает на крите и только на нём', () => {
    const yes = fight(
      striker({ traits: ['pyromancer'], critBonus: 1 }),
      dummy({ pathBonusHp: 2000 }),
      'pyro',
    );
    const crits = yes.log.events.filter((e) => e.t === 'damage' && e.target === 1 && e.crit);
    expect(crits.length).toBeGreaterThan(2);
    expect(fires(yes.log.events, 'pyromancer').length).toBe(crits.length);

    const no = fight(
      striker({ traits: ['pyromancer'], critBonus: -1, agi: 0 }),
      dummy({ pathBonusHp: 2000 }),
      'pyro',
    );
    expect(no.log.events.filter((e) => e.t === 'damage' && e.target === 1).length).toBeGreaterThan(
      3,
    );
    expect(fires(no.log.events, 'pyromancer')).toEqual([]);
  });

  it('leech лечит долей нанесённого и не поднимает выше максимума', () => {
    const frac = T('leech', 'healFraction');
    const self = createFighterState(
      fighter({ traits: ['leech'], atk: 40, pathBonusHp: 400 }),
      balance,
    );
    const foe = createFighterState(dummy({ pathBonusHp: 2000 }), balance);
    self.hp = 10;

    const events = [...TRAITS.values()]
      .filter((t) => t.id === 'leech')
      .flatMap((t) =>
        t.hooks.onHit!({
          self,
          selfIndex: 0,
          opponent: foe,
          opponentIndex: 1,
          balance,
          rng: { next: () => 0, chance: () => false, int: () => 0 } as never,
          clock: createStatusClock(),
          state: createTraitState(),
          amount: 50,
        }),
      );
    expect(events.length, 'хук не сработал — проверять нечего').toBe(1);
    expect(self.hp).toBe(10 + Math.round(50 * frac));

    // На полном HP лечение не переливает через край и события не даёт.
    self.hp = self.maxHp;
    const atFull = traitDefinition('leech').hooks.onHit!({
      self,
      selfIndex: 0,
      opponent: foe,
      opponentIndex: 1,
      balance,
      rng: { next: () => 0, chance: () => false, int: () => 0 } as never,
      clock: createStatusClock(),
      state: createTraitState(),
      amount: 50,
    });
    expect(self.hp).toBe(self.maxHp);
    expect(atFull).toEqual([]);
  });

  it('frostbite замедляет цель, и замедление видно в SPD', () => {
    const { log } = fight(striker({ traits: ['frostbite'] }), dummy({ spd: 20 }), 'frost');
    const chills = applies(log.events, 'chill', 1);
    expect(chills.length).toBeGreaterThan(0);

    const victim = createFighterState(fighter({ spd: 20 }), balance);
    const before = effectiveStats(victim, createFighterState(fighter(), balance), balance).spd;
    applyStatus(victim, 1, 'chill', T('frostbite', 'chillStacks'), 0, balance, createStatusClock());
    const after = effectiveStats(victim, createFighterState(fighter(), balance), balance).spd;
    expect(after).toBeLessThan(before);
  });

  it('siphon срывает щит или регенерацию, и только их', () => {
    let removed = 0;
    let seen = 0;
    for (let i = 0; i < 80; i++) {
      const { log } = fight(
        striker({ traits: ['siphon'], atk: 5 }),
        shielded([{ id: 'hex', stacks: 1, duration: 900 }]),
        `siphon-${i}`,
      );
      for (const e of log.events) {
        if (e.t !== 'trait_fire' || e.trait !== 'siphon') continue;
        removed++;
        expect(['shield', 'regen']).toContain(e.note);
      }
      seen += log.events.filter((e) => e.t === 'status_apply' && e.status === 'shield').length;
    }
    expect(seen, 'щита на цели не было — срывать нечего').toBeGreaterThan(0);
    expect(removed, 'ни одного срыва за восемьдесят боёв').toBeGreaterThan(0);
  });
});

describe('врождённые трейты причин изгнания', () => {
  it('innateThief копит множитель за серию и сбрасывает его промахом', () => {
    const per = T('innateThief', 'damagePerConsecutiveHit');
    const cap = T('innateThief', 'maxStacks');

    expect(modifiersWithState('innateThief', { stacks: 0 }).outgoingDamageMultiplier).toBeCloseTo(
      1,
      6,
    );
    expect(modifiersWithState('innateThief', { stacks: 3 }).outgoingDamageMultiplier).toBeCloseTo(
      1 + 3 * per,
      6,
    );

    // Кап действительно кап: хук не пускает стеки выше него.
    const state = createTraitState();
    const ctx = {
      self: createFighterState(fighter({ traits: ['innateThief'] }), balance),
      selfIndex: 0 as const,
      opponent: createFighterState(fighter(), balance),
      opponentIndex: 1 as const,
      balance,
      rng: { next: () => 0, chance: () => false, int: () => 0 } as never,
      clock: createStatusClock(),
      state,
    };
    const def = traitDefinition('innateThief');
    for (let i = 0; i < cap + 5; i++) def.hooks.onHit!({ ...ctx, amount: 10 });
    expect(state.stacks).toBe(cap);

    // Промах обнуляет — и до промаха там было не ноль.
    expect(state.stacks).toBeGreaterThan(0);
    def.hooks.onBeforeAttack!({ ...ctx, missed: true });
    expect(state.stacks).toBe(0);
  });

  it('innateGuard режет первый удар и только первый', () => {
    const reduction = T('innateGuard', 'firstHitReduction');
    const seed = 'guard';
    const attacker = striker({ atk: 30 });
    const plain = resolveBattle(
      [attacker, dummy({ pathBonusHp: 2000 })] as BattleSetup,
      balance,
      seed,
    );
    const guarded = resolveBattle(
      [attacker, dummy({ pathBonusHp: 2000, traits: ['innateGuard'] })] as BattleSetup,
      balance,
      seed,
    );

    const dmg = (r: typeof plain) =>
      r.log.events
        .filter((e) => e.t === 'damage' && e.target === 1)
        .map((e) => (e.t === 'damage' ? e.amount : 0));

    const a = dmg(plain);
    const b = dmg(guarded);
    expect(a.length, 'ударов не было').toBeGreaterThan(3);
    expect(b[0]).toBe(Math.round(a[0]! * (1 - reduction)));
    // Второй удар уже полный — иначе это была бы броня, а не «первый удар».
    expect(b[1]).toBe(a[1]);
    expect(fires(guarded.log.events, 'innateGuard')).toHaveLength(1);
  });

  it('innateAdvocate даёт гарантированный крит после уклонения', () => {
    // Трейт взводится, когда уклоняется ЕГО НОСИТЕЛЬ. Значит носитель
    // стоит вторым: он уклоняется от ударов первого и бьёт в ответ.
    // Шанс крита у него обнулён (AGI 0 и отрицательный бонус), поэтому
    // любой крит в этом бою может прийти только от гарантии.
    const carrier = (traits: TraitId[]) =>
      fighter({
        spd: 10,
        agi: 60,
        atk: 20,
        accuracy: 500,
        critBonus: -1,
        pathBonusHp: 3000,
        traits,
      });
    const pressure = fighter({
      spd: 10,
      atk: 10,
      accuracy: 0,
      agi: 0,
      critBonus: -1,
      pathBonusHp: 3000,
    });

    const control = resolveBattle([pressure, carrier([])] as BattleSetup, balance, 'advocate');
    const controlCrits = control.log.events.filter((e) => e.t === 'damage' && e.crit).length;
    expect(
      control.log.events.filter((e) => e.t === 'dodge' && e.actor === 1).length,
      'носитель ни разу не уклонился — взводить было нечем',
    ).toBeGreaterThan(2);
    expect(controlCrits, 'в контроле крит всё же случился — гарантию не отличить от броска').toBe(
      0,
    );

    const armed = resolveBattle(
      [pressure, carrier(['innateAdvocate'])] as BattleSetup,
      balance,
      'advocate',
    );
    const crits = armed.log.events.filter((e) => e.t === 'damage' && e.target === 0 && e.crit);

    expect(crits.length, 'взведённый трейт не дал ни одного крита').toBeGreaterThan(0);
    expect(fires(armed.log.events, 'innateAdvocate', 1).length).toBe(crits.length);
  });

  it('innateScholar продлевает СВОИ статусы на заявленное число тиков', () => {
    const extra = T('innateScholar', 'extraDuration');
    const seed = 'scholar';
    const plain = resolveBattle(
      [striker({ traits: ['plaguebearer'], atk: 1 }), dummy({ pathBonusHp: 3000 })] as BattleSetup,
      balance,
      seed,
    );
    const scholar = resolveBattle(
      [
        striker({ traits: ['plaguebearer', 'innateScholar'], atk: 1 }),
        dummy({ pathBonusHp: 3000 }),
      ] as BattleSetup,
      balance,
      seed,
    );

    const firstDuration = (r: typeof plain) => {
      const e = r.log.events.find((x) => x.t === 'status_apply' && x.status === 'poison');
      return e?.t === 'status_apply' ? e.duration : NaN;
    };

    expect(firstDuration(plain)).toBe(balance.statuses.poison.duration);
    expect(firstDuration(scholar)).toBe(balance.statuses.poison.duration + extra);
  });
});

/* ────────────────────────── сверка с локалями ────────────────────────── */

describe('описания сверены с реализацией', () => {
  it('у каждого трейта есть имя и описание в обеих локалях', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (lang: string) =>
      JSON.parse(
        readFileSync(new URL(`../../../../locales/${lang}.json`, import.meta.url), 'utf8'),
      ) as Record<string, string>;

    for (const lang of ['ru', 'en']) {
      const dict = read(lang);
      const missing = ALL_TRAIT_IDS.flatMap((id) =>
        [`trait.${id}.name`, `trait.${id}.desc`].filter((key) => !(key in dict)),
      );
      expect(missing, `нет строк в locales/${lang}.json`).toEqual([]);
    }
  });

  it('числа из описаний совпадают с balance.json', async () => {
    const { readFileSync } = await import('node:fs');
    const ru = JSON.parse(
      readFileSync(new URL('../../../../locales/ru.json', import.meta.url), 'utf8'),
    ) as Record<string, string>;

    /**
     * Ровно та ошибка v1.0: описание обещало 15%, код давал ×1.05.
     * Здесь число из строки локали сверяется с числом из данных.
     */
    const claims: Array<[TraitId, string, number]> = [
      ['warlord', 'atkPerKill', T('warlord', 'atkPerKill')],
      ['cursed', 'damageMultiplier', T('cursed', 'damageMultiplier')],
      ['cursed', 'hpFractionPerTurn', T('cursed', 'hpFractionPerTurn') * 100],
      ['executioner', 'hpThreshold', T('executioner', 'hpThreshold') * 100],
      ['executioner', 'damageMultiplier', T('executioner', 'damageMultiplier')],
      ['bloodlust', 'chance', T('bloodlust', 'chance') * 100],
      ['berserker', 'maxBonus', T('berserker', 'maxBonus') * 100],
      ['ironGrip', 'armorPenetration', T('ironGrip', 'armorPenetration') * 100],
      ['butcher', 'damageBonusVsBleeding', T('butcher', 'damageBonusVsBleeding') * 100],
      ['thorns', 'reflectFraction', T('thorns', 'reflectFraction') * 100],
      ['thorns', 'maxReflectPerHit', T('thorns', 'maxReflectPerHit')],
      ['slippery', 'incomingReduction', T('slippery', 'incomingReduction') * 100],
      ['secondWind', 'hpThreshold', T('secondWind', 'hpThreshold') * 100],
      ['bulwark', 'shieldStacks', T('bulwark', 'shieldStacks')],
      ['stoneskin', 'armorMultiplier', (T('stoneskin', 'armorMultiplier') - 1) * 100],
      ['hardened', 'armor', T('hardened', 'armor')],
      ['phantom', 'avoidChance', T('phantom', 'avoidChance') * 100],
      ['windup', 'everyNTurns', T('windup', 'everyNTurns')],
      ['windup', 'damageMultiplier', T('windup', 'damageMultiplier')],
      ['riposte', 'bleedStacks', T('riposte', 'bleedStacks')],
      ['quickstep', 'spdMultiplier', (T('quickstep', 'spdMultiplier') - 1) * 100],
      ['deadeye', 'accuracy', T('deadeye', 'accuracy')],
      ['bleedout', 'bleedStacks', T('bleedout', 'bleedStacks')],
      ['hexblade', 'chance', T('hexblade', 'chance') * 100],
      ['plaguebearer', 'chance', T('plaguebearer', 'chance') * 100],
      ['amplifier', 'dotDamageBonus', T('amplifier', 'dotDamageBonus') * 100],
      ['leech', 'healFraction', T('leech', 'healFraction') * 100],
      ['frostbite', 'chance', T('frostbite', 'chance') * 100],
      ['siphon', 'chance', T('siphon', 'chance') * 100],
      ['innateThief', 'damagePerConsecutiveHit', T('innateThief', 'damagePerConsecutiveHit') * 100],
      ['innateGuard', 'firstHitReduction', T('innateGuard', 'firstHitReduction') * 100],
      ['innateScholar', 'extraDuration', T('innateScholar', 'extraDuration')],
    ];

    for (const [id, key, value] of claims) {
      const desc = ru[`trait.${id}.desc`] ?? '';
      const numbers = [...desc.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) =>
        Number(m[0].replace(',', '.')),
      );
      expect(numbers, `«${desc}» не содержит ${value} (${id}.${key} из balance.json)`).toContain(
        Number(value.toFixed(4)),
      );
    }
  });
});

/* ───────────────────── механики босса, GDD §7.5 ──────────────────────── */

describe('босс', () => {
  it('bossEnrage срабатывает ОДИН раз и вешает enrage на себя', () => {
    const boss = striker({
      traits: ['bossEnrage'],
      atk: 3,
      statuses: [{ id: 'bleed', stacks: 9, duration: 400 }],
    });
    const { log } = fight(boss, dummy({ pathBonusHp: 6000 }), 'enrage-once');

    // Сработал — и ровно однажды: «входит в ярость» не значит «входит
    // каждый ход», а состояние трейта — единственное, что его держит.
    expect(fires(log.events, 'bossEnrage', 0)).toHaveLength(1);
    expect(applies(log.events, 'enrage', 0).length).toBeGreaterThan(0);
  });

  it('bossEnrage НЕ срабатывает, пока HP выше порога', () => {
    /* Проверка отсутствия обязана доказать, что событие в этой же
       выборке вообще бывает, — иначе она проходит и на бое, где порог
       не пересекается ни разу. Второй бой ровно за этим. */
    const healthy = fight(
      striker({ traits: ['bossEnrage'], atk: 0, pathBonusHp: 4000 }),
      dummy({ pathBonusHp: 40 }),
      'enrage-healthy',
    );
    expect(fires(healthy.log.events, 'bossEnrage', 0)).toHaveLength(0);

    const wounded = fight(
      striker({
        traits: ['bossEnrage'],
        atk: 3,
        statuses: [{ id: 'bleed', stacks: 9, duration: 400 }],
      }),
      dummy({ pathBonusHp: 6000 }),
      'enrage-wounded',
    );
    expect(fires(wounded.log.events, 'bossEnrage', 0).length).toBeGreaterThan(0);
  });

  it('телеграф стоит в логе ДО удара, а не рядом с ним', () => {
    /* В этом вся механика §7.5: игрок не может отреагировать, но обязан
       увидеть, что удар был предсказуем. Событие, выпущенное в тот же
       ход, стояло бы в журнале рядом с уроном и ничего бы
       не предсказывало. */
    const every = T('bossHeavyStrike', 'everyNTurns');
    const { log } = fight(
      striker({ traits: ['bossHeavyStrike'], atk: 5 }),
      dummy({ pathBonusHp: 6000 }),
      'telegraph',
    );

    const telegraphs = log.events.filter((e) => e.t === 'telegraph');
    expect(telegraphs.length, 'замаха не случилось вовсе').toBeGreaterThan(0);

    // Ходы босса по порядку. Замах обязан приходиться на ход, ЗА КОТОРЫМ
    // идёт тяжёлый: то есть на каждый (every − 1)-й от начала цикла.
    let turns = 0;
    const telegraphTurns: number[] = [];
    for (const event of log.events) {
      if (event.t === 'turn_start' && event.actor === 0) turns += 1;
      if (event.t === 'telegraph') telegraphTurns.push(turns);
    }

    for (const turn of telegraphTurns) {
      expect((turn + 1) % every, `замах на ходу ${turn}, а тяжёлый удар не на следующем`).toBe(0);
    }

    /* И ГЛАВНОЕ: между замахом и обещанным ударом не должно стоять
       ДРУГОГО удара босса.

       Раньше событие выпускалось в начале хода — то есть перед обычным
       ударом ТОГО ЖЕ хода. Порядок ходов при этом был верен, и проверка
       выше проходила, но в журнале строка вставала вплотную над обычным
       ударом и читалась как подпись к нему: «замахивается», следом −25,
       и игрок заключал, что тяжёлый уже случился. Поймано глазами
       на скриншоте, а не тестом, — поэтому проверка теперь есть. */
    const mult = T('bossHeavyStrike', 'damageMultiplier');
    let checked = 0;

    for (let i = 0; i < log.events.length; i += 1) {
      if (log.events[i]!.t !== 'telegraph') continue;

      const after = log.events
        .slice(i + 1)
        .filter((e) => e.t === 'attack' && e.actor === 0) as Extract<
        (typeof log.events)[number],
        { t: 'attack' }
      >[];
      const next = after[0];
      if (next === undefined) continue;

      // Ничего, кроме этого трейта, множитель атаки у бойца не трогает,
      // поэтому обещанный удар отличается от обычного ровно в `mult` раз.
      const plain = (
        log.events.filter((e) => e.t === 'attack' && e.actor === 0) as (typeof after)[number][]
      ).map((e) => e.roll.atkMultiplier);
      const base = Math.min(...plain);

      expect(
        next.roll.atkMultiplier / base,
        'сразу за замахом идёт ОБЫЧНЫЙ удар босса — на экране замах читается как подпись к нему',
      ).toBeCloseTo(mult, 5);
      checked += 1;
    }

    // Проверка «за замахом идёт тяжёлый» бессмысленна, если ни одного
    // замаха с последующим ударом в выборке не случилось.
    expect(checked, 'ни один замах не дошёл до своего удара').toBeGreaterThan(0);
  });

  it('обещанный удар действительно тяжелее обычного', () => {
    // Телеграф, за которым не следует усиленный удар, — это пункт 4
    // аудита v1.0: число в описании без последствий в бою.
    const every = T('bossHeavyStrike', 'everyNTurns');
    const mult = T('bossHeavyStrike', 'damageMultiplier');

    const plain = createFighterState(fighter({ traits: ['bossHeavyStrike'] }), balance);
    const target = createFighterState(fighter(), balance);

    // Ход, который НЕ кратен периоду: множителя нет.
    plain.traitStates.get('bossHeavyStrike')!.turns = every - 1;
    expect(effectiveStats(plain, target, balance).outgoingDamageMultiplier).toBe(1);

    // Ход, который кратен: множитель ровно заявленный.
    plain.traitStates.get('bossHeavyStrike')!.turns = every;
    expect(effectiveStats(plain, target, balance).outgoingDamageMultiplier).toBe(mult);
  });

  it('трейты монстров не входят в пул выбора игрока', () => {
    // Иначе игрок однажды взял бы «замах босса» карточкой на уровне.
    for (const id of MONSTER_TRAIT_IDS) {
      expect(TRAIT_IDS as readonly string[]).not.toContain(id);
      expect(traitDefinition(id).school).toBe('monster');
    }
  });
});
