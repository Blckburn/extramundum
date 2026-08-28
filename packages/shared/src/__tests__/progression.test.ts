import { describe, expect, it } from 'vitest';

import {
  autoStatBonus,
  isCardUnlocked,
  isTraitLevel,
  levelForXp,
  offerCards,
  offerTraits,
  xpForLevel,
  EMPTY_LEANS,
  type BuildLeans,
  type CardSpec,
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
