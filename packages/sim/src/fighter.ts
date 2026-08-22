import type {
  ArmorClass,
  CombatBalance,
  FighterConfig,
  TraitId,
  WeaponClass,
} from '@extramundum/shared';

import { activeModifiers, type StatusInstance } from './statuses.js';
import { activeTraitModifiers, createTraitState, type TraitState } from './traits.js';

/**
 * Производные величины бойца. GDD §4.2.
 *
 * Всё, что здесь считается, считается ОДИН раз при входе в бой и дальше
 * не пересчитывается. Причина — пункт 2 аудита v1.0: там
 * `applyEquippedToFighter` заново выводил максимум HP по формуле при
 * каждом входе в бой и молча стирал бонусы путей. Три билда из десяти
 * не работали, и никто не замечал, потому что число выглядело правдоподобно.
 */

/** Изменяемое состояние бойца по ходу боя. */
export type FighterState = {
  readonly config: FighterConfig;
  readonly maxHp: number;
  hp: number;
  /** Накопитель инициативы. GDD §4.1. */
  initiative: number;
  /** Активные статусы. Могут быть несколько экземпляров одного вида. */
  statuses: StatusInstance[];
  /**
   * Пропустил ли боец ПРЕДЫДУЩИЙ свой ход из-за контроля.
   *
   * Защита от стан-лока (GDD §4.4) — жёсткое правило, а не вероятность:
   * пропустивший ход не может быть остановлен снова на следующем.
   * Без этого достаточно двух источников стана, чтобы боец не сходил
   * ни разу за бой, и это не баланс, а неиграбельность.
   */
  skippedLastTurn: boolean;
  /** Состояние трейтов в пределах боя: счётчики, стеки, взведённость. */
  traitStates: Map<TraitId, TraitState>;
};

/**
 * Максимум HP: `60 + DEF × 6 + уровень × 14 + бонусы_путей` (GDD §4.2).
 *
 * `pathBonusHp` СКЛАДЫВАЕТСЯ, а не выводится. Единственная функция,
 * считающая максимум HP, — эта; второй такой нет и быть не должно,
 * иначе повторится расхождение v1.0.
 */
export function maxHp(config: FighterConfig, balance: CombatBalance): number {
  const { base, perDef, perLevel } = balance.maxHp;
  return base + config.def * perDef + config.level * perLevel + config.pathBonusHp;
}

export function createFighterState(config: FighterConfig, balance: CombatBalance): FighterState {
  const hp = maxHp(config, balance);
  const traitStates = new Map<TraitId, TraitState>();
  for (const id of config.traits) traitStates.set(id, createTraitState());

  return {
    config,
    maxHp: hp,
    hp,
    initiative: 0,
    statuses: [],
    skippedLastTurn: false,
    traitStates,
  };
}

/* ───────────────────────── эффективные значения ──────────────────────── */

/**
 * Статы с учётом активных статусов.
 *
 * Считаются из БАЗЫ плюс сумма модификаторов при каждом обращении,
 * а не хранятся. Хранимое значение пришлось бы возвращать к исходному
 * при истечении статуса — и однажды это забыли бы сделать, а величина
 * поехала бы на весь бой. Это ровно баг v1.0 с HP от путей (GDD §13,
 * пункт 2), только в другом месте.
 *
 * `maxHp` сюда не входит намеренно: он вычисляется один раз при входе
 * в бой, и статусы его не меняют. Плавающий максимум HP означал бы, что
 * при истечении статуса надо решать, что делать с текущим HP выше нового
 * максимума, — вопрос, которого GDD не ставит.
 */
export type EffectiveStats = {
  readonly atk: number;
  readonly agi: number;
  readonly spd: number;
  readonly armor: number;
  readonly accuracy: number;
  /** Прибавка к множителю атаки от статусов. 0 — статусов нет. */
  readonly attackMultiplierBonus: number;
  /** Шаг 0 пайплайна: шанс избежать удар целиком. */
  readonly avoidChance: number;
  /** Шаг 2: переопределение силы блока, если трейт его задаёт. */
  readonly blockReductionOverride: number | undefined;
  /** Шаг 6: доля игнорируемой брони цели. */
  readonly armorPenetration: number;
  /** Множитель шанса крита ПРОТИВНИКА по этому бойцу. */
  readonly enemyCritMultiplier: number;
  /** Множители урона от трейтов. */
  readonly outgoingDamageMultiplier: number;
  readonly incomingDamageMultiplier: number;
  /** Прибавка к урону своих эффектов на цели. Трейты плюс фокус. */
  readonly dotDamageBonus: number;
  /**
   * Шаг 4: множитель семейства «Мощь» (GDD §6.1).
   *
   * Учтены ТОЛЬКО ДВЕ СИЛЬНЕЙШИЕ — бюджет семейства. Держится здесь,
   * а не на генерации и не на сервере: предмет создаётся, не зная, кто
   * его наденет, а правило на сервере было бы механикой без теста.
   */
  readonly mightMultiplier: number;
  /** Крит без броска на ближайшем ударе. */
  readonly guaranteedCrit: boolean;
};

/**
 * Эффективные значения бойца.
 *
 * Складываются три источника: база из конфигурации, модификаторы
 * активных статусов и пассивы трейтов. Ни один из них не мутируется —
 * всё считается заново при каждом обращении.
 *
 * `opponent` нужен потому, что часть пассивов зависит от цели:
 * `executioner` сильнее по раненому, `butcher` — по истекающему кровью.
 * Пассив, смотрящий на противника, — это не исключение, а нормальный
 * случай в игре про матчапы.
 */
export function effectiveStats(
  fighter: FighterState,
  opponent: FighterState,
  balance: CombatBalance,
): EffectiveStats {
  const base = fighter.config;
  const sm = fighter.statuses.length > 0 ? activeModifiers(fighter, balance) : {};
  const tm =
    base.traits.length > 0
      ? activeTraitModifiers(fighter, opponent, balance)
      : ({} as ReturnType<typeof activeTraitModifiers>);

  const atk = Math.max(0, (base.atk + (sm.atk ?? 0) + (tm.atk ?? 0)) * (tm.atkMultiplier ?? 1));
  const armor = Math.max(
    0,
    (base.armor + (sm.armor ?? 0) + (tm.armor ?? 0)) *
      (sm.armorMultiplier ?? 1) *
      (tm.armorMultiplier ?? 1),
  );

  // Фокус в оффхенде усиливает статусы, наложенные НОСИТЕЛЕМ, — тем же
  // механизмом, что трейт `amplifier`, а не вторым понятием рядом.
  const focusBonus =
    base.offhand !== null && base.offhand.kind === 'focus' ? base.offhand.statusPower - 1 : 0;

  return {
    atk,
    agi: Math.max(0, base.agi + (sm.agi ?? 0) + (tm.agi ?? 0)),
    // Пол по SPD, а не ноль: замедленный боец обязан продолжать ходить.
    // Ноль — это вечная заморозка, контроль без выхода; GDD §4.4 такой
    // случай запрещает для стана жёстким правилом, и для замедления
    // он не менее плох.
    spd: Math.max(
      balance.tick.minSpd,
      (base.spd + (sm.spd ?? 0) + (tm.spd ?? 0)) * (tm.spdMultiplier ?? 1),
    ),
    armor,
    accuracy: Math.max(0, base.accuracy + (sm.accuracy ?? 0) + (tm.accuracy ?? 0)),
    attackMultiplierBonus: sm.attackMultiplierBonus ?? 0,
    avoidChance: tm.avoidChance ?? 0,
    blockReductionOverride: tm.blockReductionOverride,
    armorPenetration: tm.armorPenetration ?? 0,
    enemyCritMultiplier: tm.enemyCritMultiplier ?? 1,
    outgoingDamageMultiplier: tm.outgoingDamageMultiplier ?? 1,
    incomingDamageMultiplier: tm.incomingDamageMultiplier ?? 1,
    dotDamageBonus: (tm.dotDamageBonus ?? 0) + focusBonus,
    guaranteedCrit: tm.guaranteedCrit ?? false,
    mightMultiplier: mightMultiplier(base.damageAffixes, balance),
  };
}

/**
 * Множитель семейства «Мощь» из аффиксов носителя. GDD §6.1.
 *
 * Берутся ДВЕ СИЛЬНЕЙШИЕ (`balance.items.mightBudget`), остальные
 * не считаются. Без ограничения счёта лестница перестаёт значить:
 * четыре аффикса T1 против четырёх T5 дают ×1.5 урона, то есть тир
 * снаряжения решал бы бой в одиночку.
 *
 * Сортировка копии, а не самого массива: конфигурация бойца общая
 * на весь прогон матрицы, и мутировать её здесь значило бы менять
 * входные данные из функции, которая обязана быть чистой.
 */
export function mightMultiplier(affixes: readonly number[], balance: CombatBalance): number {
  if (affixes.length === 0) return 1;

  const counted = [...affixes].sort((a, b) => b - a).slice(0, balance.items.mightBudget);
  let multiplier = 1;
  for (const value of counted) multiplier *= 1 + value;
  return multiplier;
}

/**
 * Множитель уровня предмета: `1 + ilvl × коэффициент` (GDD §6.1).
 * Масштабирует базу оружия, поэтому входит в разбор броска отдельным
 * числом — игрок должен видеть вклад ilvl, а не получать готовый итог.
 */
export function ilvlScale(ilvl: number, balance: CombatBalance): number {
  return 1 + ilvl * balance.items.ilvlScale;
}

/** Множитель матчапа «класс оружия × класс брони». GDD §4.3. */
export function matchupMultiplier(
  weapon: WeaponClass,
  armor: ArmorClass,
  balance: CombatBalance,
): number {
  const row = balance.matchup[weapon];
  const value = row?.[armor];
  // Пустая клетка таблицы — это ошибка данных, а не повод молча бить
  // с множителем 1: так незаметно исчезла бы вся система матчапов.
  if (value === undefined) {
    throw new Error(`balance.matchup: нет клетки «${weapon} × ${armor}»`);
  }
  return value;
}

/**
 * Шанс уклонения: `clamp(base + (AGI_защ − ACC_атак) × k, min, max)`.
 * GDD §4.2. ACC — производная из экипировки, без аффиксов ноль.
 */
export function dodgeChance(
  defenderAgi: number,
  attackerAccuracy: number,
  balance: CombatBalance,
): number {
  const { base, perAgiOverAccuracy, min, max } = balance.dodge;
  const raw = base + (defenderAgi - attackerAccuracy) * perAgiOverAccuracy;
  return Math.min(max, Math.max(min, raw));
}

/** Шанс крита: `base + AGI × k + бонусы`, с капом. GDD §4.2. */
export function critChance(agi: number, critBonus: number, balance: CombatBalance): number {
  const { base, perAgi, cap } = balance.crit;
  return Math.min(cap, base + agi * perAgi + critBonus);
}

/**
 * Митигация бронёй: `ARM / (ARM + C + k × уровень_атакующего)`, кап 75%.
 * GDD §4.2.
 *
 * Уровень берётся у АТАКУЮЩЕГО: одна и та же броня хуже держит удар
 * противника выше уровнем. Это то, что не даёт броне решать бой в одиночку.
 */
export function mitigation(
  defenderArmor: number,
  attackerLevel: number,
  balance: CombatBalance,
): number {
  const { armorConstant, armorPerAttackerLevel, cap } = balance.damage.mitigation;
  const denominator = defenderArmor + armorConstant + armorPerAttackerLevel * attackerLevel;
  if (denominator <= 0) return 0;
  return Math.min(cap, defenderArmor / denominator);
}

/**
 * Множитель ATK: `(1 + ATK / делитель) × (1 + прибавки статусов)`.
 * ATK множит урон, а не прибавляется к нему (GDD §4.2).
 *
 * Прибавка статусов входит СЮДА, а не отдельным полем разбора: `enrage`
 * по §7.5 даёт «+50% урона», и как множитель атаки это ровно +50%.
 * Отдельное поле в `RollBreakdown` означало бы правку формата лога;
 * складывать же его с чем-то другим было бы неверно арифметически.
 */
export function atkMultiplier(atk: number, balance: CombatBalance, statusBonus = 0): number {
  return (1 + atk / balance.damage.atkDivisor) * (1 + statusBonus);
}
