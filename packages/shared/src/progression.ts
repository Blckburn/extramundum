import { z } from 'zod';

/**
 * Прогрессия: уровни, драфт карт, выбор трейта. GDD §5.2.
 *
 * ЗДЕСЬ ТОЛЬКО КОНТРАКТ И ЧИСТЫЕ ПРАВИЛА. Ни одного обращения к базе
 * и ни одного имени карты: карты — данные (`packages/data/cards.json`),
 * а состояние игрока читает сервер.
 *
 * Правила живут в `shared`, а не на сервере, по той же причине, что
 * `enemyLevel`: их считает и сервер, и превью, и тест. Второе место
 * разошлось бы с первым, и игрок увидел бы одно, а получил другое.
 */

/* ────────────────────────────── карты ────────────────────────────── */

/**
 * Наклон карты — что она засчитывает В БИЛД.
 *
 * Не то же самое, что стат: броня и HP считаются защитой, точность
 * и крит — ловкостью. Игрок, трижды взявший броню, собирает защитный
 * билд, и колода обязана это понимать; иначе «фильтр по билду» разбирал
 * бы четыре стата и не видел бы остального.
 */
export const CARD_LEANS = ['atk', 'def', 'agi', 'spd'] as const;
export const cardLeanSchema = z.enum(CARD_LEANS);
export type CardLean = z.infer<typeof cardLeanSchema>;

export const CARD_TIERS = ['base', 'synergy', 'deep'] as const;
export const cardTierSchema = z.enum(CARD_TIERS);
export type CardTier = z.infer<typeof cardTierSchema>;

/**
 * Прибавки карты. Поля — ТЕ ЖЕ, что у бойца.
 *
 * Второго словаря «имя эффекта → что менять» не заводится: он и есть
 * то место, где карта начинает делать не то, что написано. Ключ,
 * которого нет у бойца, схема не пропустит.
 */
export const cardEffectsSchema = z
  .object({
    atk: z.number().optional(),
    def: z.number().optional(),
    agi: z.number().optional(),
    spd: z.number().optional(),
    armor: z.number().optional(),
    accuracy: z.number().optional(),
    pathBonusHp: z.number().optional(),
    critBonus: z.number().optional(),
  })
  .strict();
export type CardEffects = z.infer<typeof cardEffectsSchema>;

export const cardSpecSchema = z.object({
  id: z.string().min(1),
  lean: cardLeanSchema,
  tier: cardTierSchema,
  effects: cardEffectsSchema,
});
export type CardSpec = z.infer<typeof cardSpecSchema>;

/* ────────────────────────── кривая опыта ─────────────────────────── */

export type ProgressionBalance = {
  readonly levelCap: number;
  readonly xpCurve: { readonly coefficient: number; readonly exponent: number };
  readonly statPerLevel: number;
  readonly synergyThreshold: number;
  readonly deepSynergyThreshold: number;
  readonly traitEveryNLevels: number;
  readonly levelUpCardCount: number;
};

/**
 * Сколько ВСЕГО опыта нужно, чтобы стоять на уровне `level`. GDD §5.2.
 *
 * Порог НАКОПИТЕЛЬНЫЙ, а не «за уровень»: игрок копит один счётчик,
 * и сравнивать его надо с одним числом. Разность двух порогов даёт
 * «сколько осталось» — обратное восстановить из «за уровень» нельзя,
 * не суммируя всю кривую заново на каждом показе.
 */
export function xpForLevel(level: number, balance: ProgressionBalance): number {
  if (level <= 1) return 0;
  const { coefficient, exponent } = balance.xpCurve;
  let total = 0;
  for (let lv = 1; lv < level; lv += 1) total += Math.round(coefficient * lv ** exponent);
  return total;
}

/**
 * Какой уровень соответствует накопленному опыту, с учётом капа.
 *
 * КАП — ЖЁСТКИЙ. За ним опыт продолжает копиться (его тратит Paragon,
 * §5.4), но уровень не растёт: иначе проверка в схеме БД
 * `level between 1 and 40` роняла бы запись боя.
 */
export function levelForXp(xp: number, balance: ProgressionBalance): number {
  let level = 1;
  while (level < balance.levelCap && xp >= xpForLevel(level + 1, balance)) level += 1;
  return level;
}

/* ──────────────────────── что даёт уровень ───────────────────────── */

/** Уровень, на котором дают трейт, а не карту. GDD §5.2: каждый пятый. */
export function isTraitLevel(level: number, balance: ProgressionBalance): boolean {
  return level % balance.traitEveryNLevels === 0;
}

/**
 * Автоматический прирост статов к уровню.
 *
 * Идёт ПОМИМО карты и не зависит от выбора: уровень обязан что-то
 * давать сам, иначе неразобранный драфт превращает повышение в пустое
 * число на экране.
 */
export function autoStatBonus(level: number, balance: ProgressionBalance): number {
  return Math.max(0, level - 1) * balance.statPerLevel;
}

/* ─────────────────────── колода и её фильтр ──────────────────────── */

/** Сколько выборов сделано в каждую сторону. Считает вызывающий. */
export type BuildLeans = Readonly<Record<CardLean, number>>;

export const EMPTY_LEANS: BuildLeans = { atk: 0, def: 0, agi: 0, spd: 0 };

/**
 * Открыта ли карта при таком билде. GDD §5.2.
 *
 * «Если игрок трижды выбрал ATK, колода начинает предлагать усилители
 * ATK-синергий» — то есть порог сравнивается с числом выборов ЭТОГО
 * наклона, а не с общим числом уровней.
 */
export function isCardUnlocked(
  card: CardSpec,
  leans: BuildLeans,
  balance: ProgressionBalance,
): boolean {
  if (card.tier === 'base') return true;
  const taken = leans[card.lean];
  return card.tier === 'synergy'
    ? taken >= balance.synergyThreshold
    : taken >= balance.deepSynergyThreshold;
}

/**
 * Бросок, выводимый из сида и уровня. Тот же приём, что у выбора
 * монстра в забеге: «что предложат» не зависит от того, сколько раз
 * игрок обновил экран.
 */
function offerRoll(seed: string, level: number, step: number): number {
  let hash = 0x811c9dc5;
  const text = `${seed}:draft:${level}:${step}`;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x100000000;
}

/**
 * Три карты уровня. GDD §5.2.
 *
 * ДЕТЕРМИНИРОВАНО от сида игрока и номера уровня, поэтому оффер
 * не хранится: сервер пересчитывает его при показе и при применении
 * выбора и принимает только то, что сам же и предложил. Подделать
 * выбор нечем — карты, которой не было в оффере, сервер не найдёт.
 *
 * Тянется БЕЗ ПОВТОРОВ: три одинаковые карты — это не выбор.
 * Если открытых карт меньше, чем нужно, отдаётся сколько есть —
 * пустой оффер лучше выдуманного.
 */
export function offerCards(
  deck: readonly CardSpec[],
  leans: BuildLeans,
  seed: string,
  level: number,
  balance: ProgressionBalance,
): readonly CardSpec[] {
  const pool = deck.filter((card) => isCardUnlocked(card, leans, balance));
  const picked: CardSpec[] = [];
  const remaining = [...pool];

  for (let step = 0; step < balance.levelUpCardCount && remaining.length > 0; step += 1) {
    const at = Math.min(
      remaining.length - 1,
      Math.floor(offerRoll(seed, level, step) * remaining.length),
    );
    const [card] = remaining.splice(at, 1);
    if (card !== undefined) picked.push(card);
  }

  return picked;
}

/**
 * Три трейта на «трейтовом» уровне.
 *
 * Уже взятые исключаются: повтор не был бы выбором, а уникальный индекс
 * в `player_traits` всё равно не дал бы записать второй такой же.
 */
export function offerTraits(
  pool: readonly string[],
  taken: readonly string[],
  seed: string,
  level: number,
  balance: ProgressionBalance,
): readonly string[] {
  const remaining = pool.filter((id) => !taken.includes(id));
  const picked: string[] = [];

  for (let step = 0; step < balance.levelUpCardCount && remaining.length > 0; step += 1) {
    const at = Math.min(
      remaining.length - 1,
      Math.floor(offerRoll(seed, level, step) * remaining.length),
    );
    const [id] = remaining.splice(at, 1);
    if (id !== undefined) picked.push(id);
  }

  return picked;
}

/* ──────────────────────────── ответы API ─────────────────────────── */

export const draftPickInputSchema = z.object({
  /** Идентификатор карты или трейта. Что именно — знает сервер по уровню. */
  choice: z.string().min(1),
});
export type DraftPickInput = z.infer<typeof draftPickInputSchema>;

/** Одна карточка для показа: числа уже посчитаны сервером. */
export type DraftOption = {
  readonly id: string;
  readonly lean: CardLean | null;
  readonly tier: CardTier | null;
  readonly effects: CardEffects;
};

export type DraftView = {
  /** Уровень, за который выбирают. `null` — разбирать нечего. */
  readonly level: number | null;
  /** Сколько уровней ещё ждут разбора после этого. */
  readonly pending: number;
  /** Трейтовый уровень (§5.2, каждый пятый) — тогда в опциях трейты. */
  readonly kind: 'card' | 'trait';
  readonly options: readonly DraftOption[];
  /** Наклоны билда — то, по чему отфильтрована колода. Показывается игроку. */
  readonly leans: BuildLeans;
};

/**
 * Опыт для полосы. Пороги считает СЕРВЕР.
 *
 * Кривая живёт в одной функции (`xpForLevel`), и клиент её не повторяет:
 * второе место разошлось бы, и полоса показывала бы не тот прогресс,
 * по которому уровень на самом деле поднимается.
 */
export type ProgressionView = {
  readonly level: number;
  readonly xp: number;
  /** Порог входа в текущий уровень. */
  readonly xpAtLevel: number;
  /** Порог следующего уровня. `null` — кап (§5.2). */
  readonly xpForNext: number | null;
};

export type DraftResponse = {
  readonly draft: DraftView;
  readonly progress: ProgressionView;
};
