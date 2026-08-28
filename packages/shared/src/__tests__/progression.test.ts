import { describe, expect, it } from 'vitest';

import {
  autoStatBonus,
  isCardUnlocked,
  isTraitLevel,
  levelForXp,
  isCardUseful,
  offerCards,
  offerTraits,
  xpForLevel,
  EMPTY_LEANS,
  type BuildLeans,
  type CardSpec,
  type CeilingBalance,
  type ProgressionBalance,
} from '../progression.js';

/**
 * Прогрессия против текста GDD §5.2.
 *
 * Числа берутся из документа, а не из balance.json: тест обязан ловить
 * расхождение данных с документом, а сверка данных с ними же его
 * не поймала бы.
 */
const balance: ProgressionBalance = {
  levelCap: 40,
  xpCurve: { coefficient: 100, exponent: 1.35 },
  statPerLevel: 1,
  synergyThreshold: 3,
  deepSynergyThreshold: 6,
  traitEveryNLevels: 5,
  levelUpCardCount: 3,
};

const card = (id: string, lean: CardSpec['lean'], tier: CardSpec['tier']): CardSpec => ({
  id,
  lean,
  tier,
  effects: { atk: 1 },
});

const DECK: readonly CardSpec[] = [
  card('a1', 'atk', 'base'),
  card('a2', 'atk', 'synergy'),
  card('a3', 'atk', 'deep'),
  card('d1', 'def', 'base'),
  card('d2', 'def', 'synergy'),
  card('g1', 'agi', 'base'),
  card('s1', 'spd', 'base'),
];

const leans = (over: Partial<BuildLeans>): BuildLeans => ({ ...EMPTY_LEANS, ...over });

describe('кривая опыта (GDD §5.2: 100 × lv^1.35, кап 40)', () => {
  it('порог накопительный, а не «за уровень»', () => {
    // Второй уровень стоит 100 × 1^1.35 = 100, третий — плюс 100 × 2^1.35.
    expect(xpForLevel(1, balance)).toBe(0);
    expect(xpForLevel(2, balance)).toBe(100);
    expect(xpForLevel(3, balance)).toBe(100 + Math.round(100 * 2 ** 1.35));
    // И он РАСТЁТ: иначе кривая была бы линейной вопреки документу.
    expect(xpForLevel(4, balance) - xpForLevel(3, balance)).toBeGreaterThan(
      xpForLevel(3, balance) - xpForLevel(2, balance),
    );
  });

  it('уровень выводится из опыта и не перескакивает порог', () => {
    expect(levelForXp(0, balance)).toBe(1);
    expect(levelForXp(99, balance)).toBe(1);
    expect(levelForXp(100, balance)).toBe(2);
    expect(levelForXp(xpForLevel(7, balance), balance)).toBe(7);
    expect(levelForXp(xpForLevel(7, balance) - 1, balance)).toBe(6);
  });

  it('кап жёсткий: за ним опыт копится, уровень нет', () => {
    /* Иначе проверка схемы `level between 1 and 40` роняла бы запись
       боя — то есть игрок упирался бы не в кап, а в ошибку. */
    const beyond = xpForLevel(40, balance) * 100;
    expect(levelForXp(beyond, balance)).toBe(40);
  });
});

describe('что даёт уровень', () => {
  it('каждый пятый уровень — трейтовый', () => {
    expect(isTraitLevel(5, balance)).toBe(true);
    expect(isTraitLevel(10, balance)).toBe(true);
    // И это ГАРАНТИЯ, а не шанс: в v1.0 было «60%».
    for (const level of [2, 3, 4, 6, 7, 8, 9]) {
      expect(isTraitLevel(level, balance), `уровень ${level}`).toBe(false);
    }
  });

  it('автоприрост идёт помимо карты и растёт с уровнем', () => {
    expect(autoStatBonus(1, balance)).toBe(0);
    expect(autoStatBonus(2, balance)).toBe(1);
    expect(autoStatBonus(40, balance)).toBe(39);
  });
});

describe('колода фильтруется по билду (GDD §5.2)', () => {
  it('базовые карты открыты всегда', () => {
    expect(isCardUnlocked(card('x', 'atk', 'base'), EMPTY_LEANS, balance)).toBe(true);
  });

  it('синергия открывается ТРЕМЯ выборами своего наклона', () => {
    const synergy = card('x', 'atk', 'synergy');
    expect(isCardUnlocked(synergy, leans({ atk: 2 }), balance)).toBe(false);
    expect(isCardUnlocked(synergy, leans({ atk: 3 }), balance)).toBe(true);
  });

  it('выборы ЧУЖОГО наклона синергию не открывают', () => {
    // Иначе «фильтр по билду» означал бы «фильтр по числу уровней»,
    // и билд перестал бы быть направленным.
    const synergy = card('x', 'atk', 'synergy');
    expect(isCardUnlocked(synergy, leans({ def: 9, agi: 9, spd: 9 }), balance)).toBe(false);
  });

  it('глубокая синергия требует вдвое больше', () => {
    const deep = card('x', 'atk', 'deep');
    expect(isCardUnlocked(deep, leans({ atk: 5 }), balance)).toBe(false);
    expect(isCardUnlocked(deep, leans({ atk: 6 }), balance)).toBe(true);
  });
});

describe('оффер трёх карт', () => {
  it('три карты, все РАЗНЫЕ', () => {
    const offer = offerCards(DECK, EMPTY_LEANS, 'seed', 2, balance);
    expect(offer).toHaveLength(3);
    expect(new Set(offer.map((c) => c.id)).size).toBe(3);
  });

  it('один сид и уровень дают ТОТ ЖЕ оффер', () => {
    /* На этом держится защита от подделки: оффер не хранится, сервер
       пересчитывает его при показе и при применении выбора. Разойдись
       два вызова — игрок выбирал бы одно, а получал другое. */
    const a = offerCards(DECK, EMPTY_LEANS, 'seed', 4, balance);
    const b = offerCards(DECK, EMPTY_LEANS, 'seed', 4, balance);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });

  it('разные уровни дают разные офферы', () => {
    // Иначе игрок видел бы одни и те же три карты всю игру.
    const seen = new Set<string>();
    for (let level = 2; level <= 12; level += 1) {
      seen.add(
        offerCards(DECK, EMPTY_LEANS, 'seed', level, balance)
          .map((c) => c.id)
          .join(','),
      );
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('в оффер не попадает запертая карта', () => {
    for (let level = 2; level <= 40; level += 1) {
      for (const c of offerCards(DECK, EMPTY_LEANS, 'seed', level, balance)) {
        expect(c.tier, `уровень ${level}, карта ${c.id}`).toBe('base');
      }
    }
  });

  it('а с набранным наклоном — попадает, и это видно', () => {
    /* Проверка «запертых нет» пуста, если запертые не появляются
       НИКОГДА: тогда она проходит и на колоде без синергий вовсе. */
    let seenSynergy = false;
    for (let level = 2; level <= 40; level += 1) {
      for (const c of offerCards(DECK, leans({ atk: 6 }), 'seed', level, balance)) {
        if (c.tier !== 'base') seenSynergy = true;
      }
    }
    expect(seenSynergy, 'синергии не выпали ни разу — фильтр нечем проверить').toBe(true);
  });

  it('колода меньше трёх карт отдаёт сколько есть, а не выдумывает', () => {
    const tiny = [card('only', 'atk', 'base')];
    expect(offerCards(tiny, EMPTY_LEANS, 'seed', 2, balance)).toHaveLength(1);
    expect(offerCards([], EMPTY_LEANS, 'seed', 2, balance)).toHaveLength(0);
  });
});

describe('карта с достигнутым потолком исчезает из колоды', () => {
  /* Числа из GDD §4.2: уклонение clamp(0.03 + AGI × 0.008, 0, 0.30),
     крит 0.05 + AGI × 0.004 с потолком 60%. Взяты из документа,
     а не из balance.json: тест обязан ловить расхождение данных
     с текстом. */
  const combat: CeilingBalance = {
    dodge: { base: 0.03, perAgiOverAccuracy: 0.008, max: 0.3 },
    crit: { base: 0.05, perAgi: 0.004, cap: 0.6 },
  };
  const fresh = { agi: 10, critBonus: 0, accuracy: 2 };

  const card = (id: string, effects: CardSpec['effects']): CardSpec => ({
    id,
    lean: 'agi',
    tier: 'base',
    effects,
  });

  it('точность мертва, когда её хватает обнулить уклонение ЛЮБОГО врага', () => {
    // 0.30 / 0.008 = 37.5 — с этого значения не уклонится никто.
    const aim = card('agi.aim', { accuracy: 2 });
    expect(isCardUseful(aim, { ...fresh, accuracy: 38 }, combat)).toBe(false);
    // И ПАРА К НЕЙ: чуть ниже порога карта обязана оставаться живой,
    // иначе проверка выше прошла бы и на фильтре, режущем всё подряд.
    expect(isCardUseful(aim, { ...fresh, accuracy: 37 }, combat)).toBe(true);
  });

  it('крит мертв на потолке 60%', () => {
    const nerve = card('agi.nerve', { critBonus: 0.02 });
    expect(isCardUseful(nerve, { ...fresh, critBonus: 0.6 }, combat)).toBe(false);
    expect(isCardUseful(nerve, { ...fresh, critBonus: 0.5 }, combat)).toBe(true);
  });

  it('AGI мертв, только когда упёрлись ОБА его потолка', () => {
    const step = card('agi.step', { agi: 3 });
    // Уклонение упёрлось (AGI 34 → 0.302 > 0.30), крит нет.
    expect(isCardUseful(step, { agi: 40, critBonus: 0, accuracy: 2 }, combat)).toBe(true);
    // Упёрлись оба.
    expect(isCardUseful(step, { agi: 40, critBonus: 0.5, accuracy: 2 }, combat)).toBe(false);
  });

  it('карта жива, пока жив ХОТЬ ОДИН её эффект', () => {
    // «Чтение боя»: AGI плюс точность. Точность упёрлась, AGI нет —
    // значит карта жива.
    const read = card('agi.read', { agi: 4, accuracy: 3 });
    expect(isCardUseful(read, { agi: 10, critBonus: 0, accuracy: 60 }, combat)).toBe(true);
    // А когда упёрлось ВСЁ, что она даёт, — исчезает.
    expect(isCardUseful(read, { agi: 40, critBonus: 0.6, accuracy: 60 }, combat)).toBe(false);
  });

  it('прибавки без потолка не умирают никогда', () => {
    const blade = card('atk.blade', { atk: 3 });
    const marrow = card('def.marrow', { pathBonusHp: 18 });
    const huge = { agi: 999, critBonus: 9, accuracy: 999 };
    expect(isCardUseful(blade, huge, combat)).toBe(true);
    expect(isCardUseful(marrow, huge, combat)).toBe(true);
  });

  it('оффер эти карты не показывает', () => {
    const deck: CardSpec[] = [
      card('agi.aim', { accuracy: 2 }),
      card('agi.nerve', { critBonus: 0.02 }),
      { id: 'atk.blade', lean: 'atk', tier: 'base', effects: { atk: 3 } },
    ];
    const capped = { agi: 10, critBonus: 0.6, accuracy: 99 };

    const offer = offerCards(deck, EMPTY_LEANS, 'seed', 2, balance, {
      values: capped,
      combat,
    });
    expect(offer.map((c) => c.id)).toEqual(['atk.blade']);

    // А БЕЗ ПОТОЛКОВ те же карты в оффере есть — иначе проверка выше
    // прошла бы и на колоде, из которой их выкинуло что угодно другое.
    const open = offerCards(deck, EMPTY_LEANS, 'seed', 2, balance);
    expect(open).toHaveLength(3);
  });
});

describe('оффер РАВНОМЕРЕН по колоде', () => {
  /* Двенадцать карт, по три на наклон, — та же форма, что у настоящей
     колоды. Порядок в массиве важен: именно по нему промахивался
     сломанный бросок. */
  const deck: CardSpec[] = (['atk', 'def', 'agi', 'spd'] as const).flatMap((lean) =>
    [0, 1, 2].map((n) => ({
      id: `${lean}.${n}`,
      lean,
      tier: 'base' as const,
      effects: {},
    })),
  );
  const at = new Map(deck.map((card, index) => [card.id, index]));

  const sample = (): { leans: Record<string, number>; adjacent: number; offers: number } => {
    const leans: Record<string, number> = { atk: 0, def: 0, agi: 0, spd: 0 };
    let adjacent = 0;
    let offers = 0;

    for (let seed = 0; seed < 300; seed += 1) {
      for (let level = 2; level <= 20; level += 1) {
        const offer = offerCards(deck, EMPTY_LEANS, `seed${seed}`, level, balance);
        for (const card of offer) leans[card.lean] = (leans[card.lean] ?? 0) + 1;
        const indexes = offer.map((c) => at.get(c.id) ?? 0).sort((a, b) => a - b);
        if ((indexes[2] ?? 0) - (indexes[0] ?? 0) <= 2) adjacent += 1;
        offers += 1;
      }
    }
    return { leans, adjacent, offers };
  };

  it('ни один наклон не предлагается заметно чаще другого', () => {
    const { leans } = sample();
    const counts = Object.values(leans);
    const expected = counts.reduce((a, b) => a + b, 0) / counts.length;
    for (const [lean, count] of Object.entries(leans)) {
      expect(Math.abs(count - expected) / expected, `наклон ${lean}`).toBeLessThan(0.05);
    }
  });

  it('три карты оффера НЕ соседние в колоде', () => {
    /* Так выглядел баг: FNV-1a кончается умножением, поэтому строки,
       различающиеся последним символом — а шаги оффера различались
       именно им, — давали почти одинаковый бросок. Все три карты
       выпадали подряд, 100% троек, и наклоны с краёв колоды
       предлагались в полтора раза реже средних.

       Проверяется не «бывает неподряд», а ДОЛЯ: 10 непрерывных окон
       из 220 сочетаний — это 4.5%, и настоящая случайность обязана
       попасть туда, а не в ноль и не в сотню. */
    const { adjacent, offers } = sample();
    const share = adjacent / offers;
    expect(share).toBeGreaterThan(0.02);
    expect(share).toBeLessThan(0.08);
  });
});

describe('оффер трёх трейтов', () => {
  const pool = ['t1', 't2', 't3', 't4', 't5'];

  it('три разных трейта', () => {
    const offer = offerTraits(pool, [], 'seed', 5, balance);
    expect(offer).toHaveLength(3);
    expect(new Set(offer).size).toBe(3);
  });

  it('уже взятые не предлагаются', () => {
    const taken = ['t1', 't2', 't3'];
    const offer = offerTraits(pool, taken, 'seed', 10, balance);
    for (const id of offer) expect(taken).not.toContain(id);
    // И что-то всё же предложено: иначе проверка выше пуста.
    expect(offer.length).toBeGreaterThan(0);
  });
});
