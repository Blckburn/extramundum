import { balance as balanceData } from '@extramundum/data';
import { CARDS, cardSpec, hasCard } from '@extramundum/data/cards';
import {
  EMPTY_LEANS,
  TRAIT_IDS,
  autoStatBonus,
  isTraitLevel,
  levelForXp,
  offerCards,
  offerTraits,
  xpForLevel,
  type BuildLeans,
  type CardLean,
  type CardSpec,
  type DraftOption,
  type DraftView,
  type PlayerProfile,
  type ProgressionBalance,
  type ProgressionView,
} from '@extramundum/shared';
import { TRAITS, maxHp as maxHpOf } from '@extramundum/sim';

import { combatBalance } from '../battle/setup.ts';
import type { Database } from '../db/client.ts';
import { AppError } from '../http/errors.ts';
import { fighterFromLoadout, type ProgressionBonuses } from '../items/loadout.ts';
import { loadoutOf } from '../items/repository.ts';
import { applyCardPick, applyTraitPick, cardPicksOf, traitPicksOf } from './repository.ts';

/**
 * Прогрессия: уровень, драфт, трейт на пятом. GDD §5.2.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И НЕ ДОЛЖНО БЫТЬ: хранимого оффера. Три карты
 * выводятся из сида игрока и номера уровня, поэтому сервер считает их
 * заново и при показе, и при применении выбора — и принимает только то,
 * что сам же и предложил. Клиент присылает идентификатор; карты,
 * которой не было в оффере, сервер не найдёт.
 *
 * УРОВЕНЬ И ВЫБОР СВЯЗАНЫ ЖЁСТКО, и это не удобство, а инвариант:
 * уровень поднимается ровно тогда, когда сделан выбор за него. Поэтому
 * «сколько драфтов ждёт» нигде не хранится — оно ВЫВОДИТСЯ из опыта
 * и числа выборов, и разойтись двум числам негде.
 */

const progression = balanceData.progression as unknown as ProgressionBalance;

/**
 * Школы трейтов — прямо из реестра движка.
 *
 * Не регистрацией при старте: забытый вызов оставил бы пул пустым,
 * и трейтовый уровень молча предлагал бы ноль вариантов. Пусть связь
 * будет импортом, который нельзя не сделать.
 *
 * Монстрячьи трейты сюда не попадают: у них `school: 'monster'`, и любой
 * перебор «трейты школы X» исключает их сам, без списка исключений
 * (§7.5).
 */
const TRAIT_SCHOOLS: ReadonlyMap<string, string> = new Map(
  [...TRAITS.values()].filter((t) => t.school !== 'monster').map((t) => [t.id, t.school]),
);

/** Наклон трейта — по школе. Защитная школа считается защитой, и так далее. */
const SCHOOL_LEAN: Readonly<Record<string, CardLean>> = {
  str: 'atk',
  def: 'def',
  agi: 'agi',
  mag: 'spd',
};

/**
 * Уровень, который игроку ПОЛОЖЕН по опыту.
 *
 * Отличается от `profile.level` ровно на число неразобранных драфтов:
 * уровень в базе поднимается только вместе с выбором.
 */
export function earnedLevel(profile: PlayerProfile): number {
  return levelForXp(profile.xp, progression);
}

/** Наклоны билда: карты плюс трейты по школам. */
export function buildLeans(
  cardIds: readonly string[],
  traitIds: readonly string[],
  traitSchool: (id: string) => string | undefined,
): BuildLeans {
  const leans = { ...EMPTY_LEANS };

  for (const id of cardIds) {
    if (!hasCard(id)) continue;
    leans[cardSpec(id).lean] += 1;
  }
  for (const id of traitIds) {
    const lean = SCHOOL_LEAN[traitSchool(id) ?? ''];
    if (lean !== undefined) leans[lean] += 1;
  }

  return leans;
}

/**
 * Сумма прибавок от всех выбранных карт.
 *
 * Считается ИЗ ВЫБОРОВ каждый раз, а не хранится числом: хранимая сумма
 * однажды разошлась бы с набором карт — это баг v1.0 с HP от путей
 * (§13, пункт 2) в другом месте.
 */
export function cardBonuses(cardIds: readonly string[]): {
  atk: number;
  def: number;
  agi: number;
  spd: number;
  armor: number;
  accuracy: number;
  pathBonusHp: number;
  critBonus: number;
} {
  const total = {
    atk: 0,
    def: 0,
    agi: 0,
    spd: 0,
    armor: 0,
    accuracy: 0,
    pathBonusHp: 0,
    critBonus: 0,
  };

  for (const id of cardIds) {
    if (!hasCard(id)) continue;
    const effects = cardSpec(id).effects;
    total.atk += effects.atk ?? 0;
    total.def += effects.def ?? 0;
    total.agi += effects.agi ?? 0;
    total.spd += effects.spd ?? 0;
    total.armor += effects.armor ?? 0;
    total.accuracy += effects.accuracy ?? 0;
    total.pathBonusHp += effects.pathBonusHp ?? 0;
    total.critBonus += effects.critBonus ?? 0;
  }

  return total;
}

/** Автоприрост за уровень — по единице в каждый стат (§5.2). */
export function autoBonus(level: number): number {
  return autoStatBonus(level, progression);
}

/* ────────────────────────────── показ ────────────────────────────── */

const toOption = (card: CardSpec): DraftOption => ({
  id: card.id,
  lean: card.lean,
  tier: card.tier,
  effects: card.effects,
});

export type DraftContext = {
  readonly profile: PlayerProfile;
  /** Сид драфта. В публичный профиль НЕ входит: по нему считаются
      будущие офферы, и клиенту знать их незачем. */
  readonly seed: string;
  readonly cardIds: readonly string[];
  readonly traitIds: readonly string[];
  readonly leans: BuildLeans;
  /** Уровень, за который выбирают сейчас. `null` — разбирать нечего. */
  readonly level: number | null;
  readonly pending: number;
};

export async function draftContext(
  db: Database,
  profile: PlayerProfile,
  seed: string,
): Promise<DraftContext> {
  const [cards, traits] = await Promise.all([
    cardPicksOf(db, profile.id),
    traitPicksOf(db, profile.id),
  ]);

  const cardIds = cards.map((c) => c.cardId);
  const traitIds = traits.map((t) => t.traitId);
  const earned = earnedLevel(profile);
  const pending = Math.max(0, earned - profile.level);

  return {
    profile,
    seed,
    cardIds,
    traitIds,
    leans: buildLeans(cardIds, traitIds, traitSchoolOf),
    // Разбирают по одному и ПО ПОРЯДКУ: выбор за третий уровень должен
    // влиять на колоду четвёртого, иначе фильтр по билду отстаёт.
    level: pending > 0 ? profile.level + 1 : null,
    pending,
  };
}

function traitSchoolOf(id: string): string | undefined {
  return TRAIT_SCHOOLS.get(id);
}

export function draftView(ctx: DraftContext): DraftView {
  if (ctx.level === null) {
    return { level: null, pending: 0, kind: 'card', options: [], leans: ctx.leans };
  }

  const seed = ctx.seed;

  if (isTraitLevel(ctx.level, progression)) {
    /* Пул — ВЫБИРАЕМЫЕ трейты (§4.5), без врождённых и монстрячьих:
       врождённый принадлежит причине изгнания, а не выбору. */
    const pool = TRAIT_IDS.filter((id) => TRAIT_SCHOOLS.has(id));
    const offered = offerTraits(pool, ctx.traitIds, seed, ctx.level, progression);
    return {
      level: ctx.level,
      pending: ctx.pending,
      kind: 'trait',
      options: offered.map((id) => ({ id, lean: null, tier: null, effects: {} })),
      leans: ctx.leans,
    };
  }

  return {
    level: ctx.level,
    pending: ctx.pending,
    kind: 'card',
    options: offerCards(CARDS, ctx.leans, seed, ctx.level, progression).map(toOption),
    leans: ctx.leans,
  };
}

/* ──────────────────────────── применение ─────────────────────────── */

/**
 * Применить выбор. GDD §5.2.
 *
 * Оффер ПЕРЕСЧИТЫВАЕТСЯ здесь же, и присланное сверяется с ним: это
 * и есть защита от подделки. Клиент не может выбрать карту, которой ему
 * не предлагали, — не потому, что интерфейс её не показал, а потому,
 * что сервер её не найдёт.
 */
export async function pickDraft(
  db: Database,
  profile: PlayerProfile,
  seed: string,
  choice: string,
): Promise<DraftView> {
  const ctx = await draftContext(db, profile, seed);

  if (ctx.level === null) {
    throw new AppError('conflict', {
      messageKey: 'error.draft.nothingPending',
      message: 'разбирать нечего',
    });
  }

  const view = draftView(ctx);
  const offered = view.options.some((option) => option.id === choice);
  if (!offered) {
    throw new AppError('forbidden', {
      messageKey: 'error.draft.notOffered',
      message: `«${choice}» не предлагался на уровне ${ctx.level}`,
    });
  }

  /* HP пересчитывается ВМЕСТЕ с уровнем: максимум зависит от DEF
     и уровня (§4.2), и повышение обязано его поднять. Иначе игрок,
     взявший карту на DEF, увидел бы полосу, не дотянутую до нового
     максимума, и не понял бы почему. */
  const loadout = await loadoutOf(db, profile.id);
  const grown: PlayerProfile = { ...profile, level: ctx.level };
  const nextCards = view.kind === 'card' ? [...ctx.cardIds, choice] : ctx.cardIds;
  const hpCurrent = maxHpOf(
    fighterFromLoadout(grown, loadout, {
      cards: cardBonuses(nextCards),
      auto: autoBonus(ctx.level),
      traits: view.kind === 'trait' ? [...ctx.traitIds, choice] : ctx.traitIds,
    }),
    combatBalance,
  );

  if (view.kind === 'trait') {
    await applyTraitPick(db, {
      playerId: profile.id,
      level: ctx.level,
      traitId: choice,
      slot: ctx.traitIds.length,
      expectedLevel: profile.level,
      hpCurrent,
    });
  } else {
    await applyCardPick(db, {
      playerId: profile.id,
      level: ctx.level,
      cardId: choice,
      expectedLevel: profile.level,
      hpCurrent,
    });
  }

  const next = await draftContext(db, { ...profile, level: ctx.level }, seed);
  return draftView(next);
}

export { xpForLevel };

/**
 * Опыт для полосы. Пороги считает сервер, клиент их не выводит.
 *
 * На капе `xpForNext` равен `null`, а не следующему порогу: полоса,
 * ползущая после сорокового, обещала бы уровень, которого нет.
 */
export function progressView(profile: PlayerProfile): ProgressionView {
  const capped = profile.level >= progression.levelCap;
  return {
    level: profile.level,
    xp: profile.xp,
    xpAtLevel: xpForLevel(profile.level, progression),
    xpForNext: capped ? null : xpForLevel(profile.level + 1, progression),
  };
}

/**
 * Прогрессия игрока из базы — то, что кладётся в сборку бойца.
 *
 * ОДНА функция на все места, где собирается игрок: бой забега, превью,
 * экран выбора зоны. Второе место означало бы бойца, у которого в бою
 * есть карты, а в превью нет.
 */
export async function progressionOf(
  db: Database,
  profile: PlayerProfile,
): Promise<ProgressionBonuses> {
  const [cards, traits] = await Promise.all([
    cardPicksOf(db, profile.id),
    traitPicksOf(db, profile.id),
  ]);

  return {
    cards: cardBonuses(cards.map((c) => c.cardId)),
    auto: autoBonus(profile.level),
    traits: traits.map((t) => t.traitId),
  };
}
