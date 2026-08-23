import { ARCHETYPE_IDS, type BattleSetup, type FighterConfig } from '@extramundum/shared';
import { describe, expect, it } from 'vitest';

import { resolveBattle } from '../resolve.js';
import { TRAITS } from '../traits.js';
import { balance } from './helpers.js';

/**
 * Баланс. GDD §4.6.
 *
 * Здесь СОКРАЩЁННАЯ выборка. Полная матрица — 10 000 боёв на пару,
 * как требует пункт 2, — гоняется скриптом `pnpm balance:matrix`
 * и отдельным workflow: на каждом `pnpm test` минуты ожидания
 * превращают проверку в ту, которую перестают запускать.
 *
 * Коридор здесь ТОТ ЖЕ, 35–65%. Ослабить его ради скорости означало бы
 * зелёный `pnpm test` при красной ночной сборке — то есть худший
 * из возможных исходов: проверка есть, а гарантии нет.
 */

const RUNS = 400;
const [LOW, HIGH] = [0.35, 0.65];

function build(archetype: (typeof ARCHETYPE_IDS)[number], extra: string[] = []): FighterConfig {
  const a = balance.archetypes[archetype];
  if (a === undefined) throw new Error(`нет статов архетипа «${archetype}»`);
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
    traits: [a.trait, ...extra] as FighterConfig['traits'],
  };
}

/**
 * Доля побед первого бойца. Стороны меняются местами на каждой второй
 * итерации: иначе меряется преимущество первого хода, а не сила билда.
 */
function winRate(a: FighterConfig, b: FighterConfig, label: string, runs = RUNS): number {
  let wins = 0;
  for (let i = 0; i < runs; i++) {
    const swap = i % 2 === 1;
    const { outcome } = resolveBattle(
      (swap ? [b, a] : [a, b]) as BattleSetup,
      balance,
      `${label}-${i}`,
    );
    if (outcome.winner !== null && (outcome.winner === 0) !== swap) wins++;
  }
  return wins / runs;
}

const pairs = ARCHETYPE_IDS.flatMap((a, i) =>
  ARCHETYPE_IDS.slice(i + 1).map((b) => [a, b] as const),
);

describe('матрица винрейтов, сокращённая выборка', () => {
  it.each(pairs)('%s против %s — в коридоре 35–65%%', (a, b) => {
    const rate = winRate(build(a), build(b), `pair-${a}-${b}`);
    expect(rate, `${a} против ${b}: ${(rate * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(LOW);
    expect(rate, `${a} против ${b}: ${(rate * 100).toFixed(1)}%`).toBeLessThanOrEqual(HIGH);
  });

  it('бои действительно доигрываются, а не упираются в лимит тиков', () => {
    // Без этого весь набор выше проходил бы при винрейте 50% из ничьих:
    // «никто не выиграл» — тоже не выход за коридор.
    let draws = 0;
    for (let i = 0; i < 200; i++) {
      const { outcome } = resolveBattle(
        [build('theft'), build('brawl')] as BattleSetup,
        balance,
        `draws-${i}`,
      );
      if (outcome.winner === null) draws++;
    }
    expect(draws, 'бои упираются в лимит — матрица меряет не победы').toBe(0);
  });
});

describe('внутри школы нет обязательного пика', () => {
  /**
   * Трейт, обгоняющий соседей по школе на десятки процентов, отменяет
   * выбор: игрок, который его не взял, играет в заведомо худшую игру,
   * а остальной список школы становится украшением.
   *
   * Порог здесь мягче коридора архетипов и это осознанно: пул трейтов
   * ещё будет расти в M3, и жёсткая рамка на этом этапе означала бы
   * подгонку чисел под неё. Ловится именно ПРОПАСТЬ, а не разница.
   */
  const HOST = { str: 'theft', def: 'brawl', agi: 'advocacy', mag: 'forbidden' } as const;
  const MAX_SPREAD = 0.4;

  /**
   * Трейты, числа которых взяты из GDD ДОСЛОВНО и калибровке не подлежат:
   * двигать их агент не вправе, правка документа — решение человека.
   *
   * Список СОКРАТИЛСЯ с шести до четырёх. `cursed` и `thorns` были в нём,
   * пока их числа оставались документными; матрица показала, что эти числа
   * негодны (14% и 87% побед против голого носителя), человек принял
   * правку, и GDD 2.5 их изменил. Теперь они калибруются наравне
   * с остальными и участвуют в разбросе.
   *
   * Исключение существует ровно до правки документа — не дольше. Список
   * задан явно и сверяется целиком: без этого он однажды разросся бы
   * до «всё, что не сходится».
   */
  const GDD_FIXED = ['warlord', 'fortress', 'phantom', 'hexblade'] as const;

  it('исключены из калибровки ровно четыре трейта с документными числами', () => {
    expect([...GDD_FIXED].sort()).toEqual(['fortress', 'hexblade', 'phantom', 'warlord']);

    // cursed и thorns вышли из списка вместе с правкой GDD 2.5. Если они
    // сюда вернутся, значит кто-то снова спрятал находку вместо того,
    // чтобы вынести её человеку.
    expect(GDD_FIXED as readonly string[]).not.toContain('cursed');
    expect(GDD_FIXED as readonly string[]).not.toContain('thorns');
  });

  it.each(Object.keys(HOST) as Array<keyof typeof HOST>)(
    'школа %s: разброс винрейтов не пропасть',
    (school) => {
      const host = HOST[school];
      const ids = [...TRAITS.values()]
        .filter((t) => t.school === school && !t.id.startsWith('innate'))
        .filter((t) => !(GDD_FIXED as readonly string[]).includes(t.id))
        .map((t) => t.id);
      expect(ids.length, `школа ${school} пуста`).toBeGreaterThan(4);

      const rates = ids.map((id) => ({
        id,
        rate: winRate(build(host, [id]), build(host), `solo-${id}`, 200),
      }));
      rates.sort((x, y) => y.rate - x.rate);

      const spread = rates[0]!.rate - rates.at(-1)!.rate;
      const table = rates.map((r) => `${r.id} ${(r.rate * 100).toFixed(0)}%`).join(', ');
      expect(spread, `разброс ${(spread * 100).toFixed(0)} п.п. — ${table}`).toBeLessThanOrEqual(
        MAX_SPREAD,
      );
    },
  );

  it('трейт вообще что-то даёт: носитель с трейтом выигрывает у голого', () => {
    // Проверка ПРОТИВ вырождения теста выше. Нулевой разброс тоже
    // «не пропасть» — и означал бы, что трейты не влияют ни на что.
    const withTrait = winRate(build('brawl', ['hardened']), build('brawl'), 'sanity', 300);
    expect(withTrait, 'трейт не влияет на исход — сравнивать нечего').toBeGreaterThan(0.55);
  });
});
