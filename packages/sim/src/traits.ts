import type { ActorIndex, BattleEvent, CombatBalance, TraitId } from '@extramundum/shared';

import type { FighterState } from './fighter.js';
import type { Rng } from './rng.js';
import { applyStatus, type StatusClock, type StatusSource } from './statuses.js';

/**
 * Трейты как хуки. GDD §4.5.
 *
 * **Правило §4.5: трейта нет в игре, пока нет теста, доказывающего, что
 * он делает то, что написано в описании.** В v1.0 шесть трейтов
 * из семнадцати были заменены на общие множители, а описания остались:
 * THORNS «отражает 15% урона» давал `fDef × 1.05`, PHANTOM «10% полностью
 * избежать удара» — `fAgi × 1.2`, WARLORD не был реализован вовсе
 * (GDD §13, пункт 3). Поэтому у каждого трейта здесь есть тест,
 * наблюдающий эффект в логе, а описания в `locales/` сверяются с кодом.
 *
 * **В `resolve.ts` не упомянут ни один трейт по имени.** Цикл вызывает
 * общие хуки, а что делает конкретный трейт, знает только этот реестр.
 * Появившийся там `if (id === '...')` означает, что интерфейс
 * спроектирован неверно.
 *
 * Хуки описывают СОБЫТИЯ. Трём аудитным трейтам их не хватило, потому
 * что их эффект пассивен: `cursed` даёт постоянный множитель ATK,
 * `fortress` меняет шаг блока, `phantom` вводит бросок до уклонения.
 * Для них есть `modify` — та же чистая функция, что у статусов.
 */

/* ──────────────────────────────── интерфейс ──────────────────────────── */

export type TraitSchool = 'str' | 'def' | 'agi' | 'mag';

/**
 * Пассивные прибавки трейта.
 *
 * Сверх статов здесь точки пайплайна: шаг 0 (избегание), шаг 2 (блок),
 * шаг 4 (множитель атаки), шаг 6 (пробивание брони). Каждое поле
 * появилось из конкретного трейта, а не «на будущее».
 */
export type TraitModifiers = {
  readonly atk?: number;
  readonly agi?: number;
  readonly spd?: number;
  readonly armor?: number;
  readonly accuracy?: number;
  /** Множитель базового ATK. `cursed`: 1.4. */
  readonly atkMultiplier?: number;
  /** Множитель брони. `stoneskin`: 1.3 при высоком HP. */
  readonly armorMultiplier?: number;
  /** Множитель SPD. `quickstep`: 1.15. */
  readonly spdMultiplier?: number;
  /** Шаг 0: шанс избежать удар целиком. `phantom`: 0.1. */
  readonly avoidChance?: number;
  /** Шаг 2: насколько блок гасит урон. `fortress`: 1.0. */
  readonly blockReductionOverride?: number;
  /** Шаг 6: доля игнорируемой брони цели. `ironGrip`: 0.25. */
  readonly armorPenetration?: number;
  /** Множитель шанса крита ПРОТИВНИКА. `slippery`: 0.5. */
  readonly enemyCritMultiplier?: number;
  /** Множитель исходящего урона. `executioner`, `berserker`, `windup`. */
  readonly outgoingDamageMultiplier?: number;
  /** Множитель входящего урона. `innateGuard`: 0.5 на первый удар. */
  readonly incomingDamageMultiplier?: number;
  /** Прибавка к урону своих эффектов на цели. `amplifier`: 0.3. */
  readonly dotDamageBonus?: number;
  /** Шаг 7: крит без броска. `innateAdvocate` после уклонения. */
  readonly guaranteedCrit?: boolean;
};

/**
 * Изменяемое состояние трейта в пределах боя.
 *
 * Собственное состояние — единственное, что трейту позволено менять
 * напрямую. Всё остальное он делает через `applyStatus` и `modify`.
 */
export type TraitState = {
  /** Сколько раз сработал. `secondWind` — один раз за бой. */
  fired: number;
  /** Накопленные стеки. `warlord`, `innateThief`. */
  stacks: number;
  /** Число своих ходов. `windup` — каждый третий. */
  turns: number;
  /** Взведён ли эффект. `innateAdvocate` — крит после уклонения. */
  armed: boolean;
};

export type TraitContext = {
  readonly self: FighterState;
  readonly selfIndex: ActorIndex;
  readonly opponent: FighterState;
  readonly opponentIndex: ActorIndex;
  readonly balance: CombatBalance;
  readonly rng: Rng;
  readonly clock: StatusClock;
  readonly state: TraitState;
  /**
   * Урон события. Есть у `onHit` и `onTakeDamage`, иначе `undefined`.
   * Без него «отражает 15% полученного» невыразимо: трейт не знает,
   * от чего считать пятнадцать процентов.
   */
  readonly amount?: number;
  readonly crit?: boolean;
  /** Промахнулся ли удар. Нужен `innateThief`, считающему серию без промахов. */
  readonly missed?: boolean;
};

export type TraitHooks = {
  onBattleStart?(ctx: TraitContext): readonly BattleEvent[];
  onBeforeAttack?(ctx: TraitContext): readonly BattleEvent[];
  onHit?(ctx: TraitContext): readonly BattleEvent[];
  onTakeDamage?(ctx: TraitContext): readonly BattleEvent[];
  onTurnStart?(ctx: TraitContext): readonly BattleEvent[];
  /**
   * Конец собственного хода, после разрешения действия.
   *
   * Существует ради предупреждений о БУДУЩЕМ: сказанное в начале хода
   * встаёт в журнале над ударом этого же хода и читается как подпись
   * к нему, а не как предсказание.
   */
  onTurnEnd?(ctx: TraitContext): readonly BattleEvent[];
  onKill?(ctx: TraitContext): readonly BattleEvent[];
};

export type Trait = {
  readonly id: TraitId;
  /**
   * Школа §4.5 — или `monster`, если трейт принадлежит противнику
   * и в пул выбора игрока не входит (§7.5). Значение, а не отдельный
   * флаг: тогда любой перебор «трейты школы X» исключает их сам,
   * без списка исключений, который однажды забудут пополнить.
   */
  readonly school: TraitSchool | 'monster';
  /** Якорный — меняет способ игры, а не добавляет процент (GDD §4.5). */
  readonly anchor?: boolean;
  modify?(ctx: TraitModifierContext): TraitModifiers;
  readonly hooks: TraitHooks;
};

/** Контекст пассива: без генератора и часов — модификатор обязан быть чистым. */
export type TraitModifierContext = {
  readonly self: FighterState;
  readonly opponent: FighterState;
  readonly balance: CombatBalance;
  readonly state: TraitState;
};

/* ───────────────────────────── помощники ─────────────────────────────── */

function num(balance: CombatBalance, trait: TraitId, key: string): number {
  const value = balance.traits[trait]?.[key];
  // Отсутствующий коэффициент — ошибка данных. Молчаливый ноль означал бы
  // трейт, который есть в описании и ничего не делает: пункт 3 аудита v1.0.
  if (value === undefined) throw new Error(`balance.traits.${trait}.${key} отсутствует`);
  return value;
}

/**
 * Наложить статус на цель — единственный путь, тот же, что в M1b.
 *
 * Вместе со статусом передаётся ИСТОЧНИК: усиление своих эффектов
 * (`amplifier`) и продление своих эффектов (`innateScholar`) принадлежат
 * накладывающему, а тикает статус на жертве. Читать их с жертвы значило бы,
 * что `amplifier` усиливает чужие эффекты на себе, — то есть описание
 * и поведение снова разошлись бы.
 */
function inflict(
  ctx: TraitContext,
  target: 'self' | 'opponent',
  status: Parameters<typeof applyStatus>[2],
  stacks: number,
): readonly BattleEvent[] {
  const fighter = target === 'self' ? ctx.self : ctx.opponent;
  const index = target === 'self' ? ctx.selfIndex : ctx.opponentIndex;
  if (fighter.hp <= 0) return [];
  return applyStatus(
    fighter,
    index,
    status,
    stacks,
    0,
    ctx.balance,
    ctx.clock,
    statusSource(ctx.self, ctx.opponent, ctx.balance),
  );
}

/** Что боец добавляет к статусам, которые накладывает сам. */
export function statusSource(
  self: FighterState,
  opponent: FighterState,
  balance: CombatBalance,
): StatusSource {
  return {
    dotDamageBonus: activeTraitModifiers(self, opponent, balance).dotDamageBonus ?? 0,
    durationBonus: statusDurationBonus(self, balance),
  };
}

/** Событие срабатывания трейта. Без него эффект не виден игроку. */
function fired(ctx: TraitContext, trait: TraitId, note?: string): BattleEvent {
  return note === undefined
    ? { t: 'trait_fire', actor: ctx.selfIndex, trait }
    : { t: 'trait_fire', actor: ctx.selfIndex, trait, note };
}

const hpFraction = (f: FighterState): number => (f.maxHp > 0 ? f.hp / f.maxHp : 0);

/* ─────────────────────────────── STR ─────────────────────────────────── */

const STR: readonly Trait[] = [
  {
    id: 'warlord',
    school: 'str',
    anchor: true,
    // «+3 ATK за победу». В v1.0 не был реализован вовсе.
    // Стек живёт до конца рейда — межбоевая часть появится в M3
    // вместе с самими рейдами; в пределах боя виден как fury.
    modify: ({ state, balance }) => ({ atk: num(balance, 'warlord', 'atkPerKill') * state.stacks }),
    hooks: {
      onKill: (ctx) => {
        ctx.state.stacks += 1;
        return [fired(ctx, 'warlord', `atk+${num(ctx.balance, 'warlord', 'atkPerKill')}`)];
      },
    },
  },
  {
    id: 'cursed',
    school: 'str',
    anchor: true,
    // «×1.4 урона, доля максимума HP за ход». В v1.0 HP не терялись вовсе.
    //
    // ДВЕ правки по результатам матрицы §4.6, обе в GDD §4.5.
    //
    // 1. Плата — ДОЛЯ максимума HP, а не плоские три единицы. Плоское
    //    число не масштабируется: на первом уровне это половина исхода
    //    боя, на сороковом — ничто.
    //
    // 2. Множитель применяется к УРОНУ, а не к стату ATK. Урон считается
    //    как `оружие × (1 + ATK/60)`, поэтому «ATK ×1.4» при ATK 10 даёт
    //    +5.7% урона, а не +40%: число в описании не имеет отношения
    //    к происходящему — ровно претензия §13, пункт 4. Замер: сам
    //    множитель стата стоит 60% побед против голого носителя, а любая
    //    осмысленная плата HP уводит трейт к 13–42%. Чтобы окупить
    //    её статом, понадобился бы ×2.2–×2.6 — число, которое в тултипе
    //    выглядит нелепо. Как множитель урона 1.4 из документа окупает
    //    2% HP за ход и даёт 60% при соседях по школе в 51–75%.
    modify: ({ balance }) => ({
      outgoingDamageMultiplier: num(balance, 'cursed', 'damageMultiplier'),
    }),
    hooks: {
      onTurnStart: (ctx) => {
        const share = num(ctx.balance, 'cursed', 'hpFractionPerTurn');
        // Округление обычное, но не ниже единицы: доля, дающая ноль,
        // превратила бы трейт в чистый бонус к урону без цены — то есть
        // в другой трейт.
        const cost = Math.max(1, Math.round(ctx.self.maxHp * share));
        const applied = Math.min(cost, ctx.self.hp);
        ctx.self.hp -= applied;
        return [
          fired(ctx, 'cursed', `hp-${applied}`),
          {
            t: 'damage',
            target: ctx.selfIndex,
            amount: applied,
            crit: false,
            hpAfter: ctx.self.hp,
          },
        ];
      },
    },
  },
  {
    id: 'executioner',
    school: 'str',
    anchor: true,
    modify: ({ opponent, balance }) =>
      hpFraction(opponent) <= num(balance, 'executioner', 'hpThreshold')
        ? { outgoingDamageMultiplier: num(balance, 'executioner', 'damageMultiplier') }
        : {},
    hooks: {},
  },
  {
    id: 'bloodlust',
    school: 'str',
    // Бросок, а не «на каждом ударе». Безусловное наложение статуса
    // на КАЖДОМ попадании выходит за рамки школы: соседи требуют либо
    // крита, либо своего броска. Матрица показала это как 80% побед
    // против 52–65% у остальных STR.
    hooks: {
      onHit: (ctx) =>
        ctx.rng.chance(num(ctx.balance, 'bloodlust', 'chance'))
          ? [
              fired(ctx, 'bloodlust'),
              ...inflict(ctx, 'opponent', 'bleed', num(ctx.balance, 'bloodlust', 'bleedStacks')),
            ]
          : [],
    },
  },
  {
    id: 'berserker',
    school: 'str',
    // Чем ниже своё HP, тем выше урон. Линейно до максимума на нуле.
    modify: ({ self, balance }) => ({
      outgoingDamageMultiplier: 1 + (1 - hpFraction(self)) * num(balance, 'berserker', 'maxBonus'),
    }),
    hooks: {},
  },
  {
    id: 'overpower',
    school: 'str',
    hooks: {
      onHit: (ctx) =>
        ctx.crit === true
          ? [
              fired(ctx, 'overpower'),
              ...inflict(ctx, 'opponent', 'stun', num(ctx.balance, 'overpower', 'stunOnCrit')),
            ]
          : [],
    },
  },
  {
    id: 'ironGrip',
    school: 'str',
    modify: ({ balance }) => ({
      armorPenetration: num(balance, 'ironGrip', 'armorPenetration'),
    }),
    hooks: {},
  },
  {
    id: 'butcher',
    school: 'str',
    modify: ({ opponent, balance }) =>
      opponent.statuses.some((s) => s.id === 'bleed')
        ? {
            outgoingDamageMultiplier: 1 + num(balance, 'butcher', 'damageBonusVsBleeding'),
          }
        : {},
    hooks: {},
  },
];

/* ─────────────────────────────── DEF ─────────────────────────────────── */

const DEF: readonly Trait[] = [
  {
    id: 'fortress',
    school: 'def',
    anchor: true,
    // «Блок гасит урон полностью». В v1.0 блок бил на 22%.
    modify: ({ balance }) => ({
      blockReductionOverride: num(balance, 'fortress', 'blockReduction'),
    }),
    hooks: {},
  },
  {
    id: 'thorns',
    school: 'def',
    anchor: true,
    // «Отражает долю полученного урона, но не больше потолка за удар».
    // В v1.0 давал fDef × 1.05, то есть не отражал ничего.
    //
    // ДВЕ правки по результатам матрицы §4.6, обе в GDD §4.5.
    //
    // 1. Доля снижена с 15%. Отражённый урон идёт МИМО БРОНИ, и в
    //    зеркальном бою тяжёлых бойцов это решает исход: 88% побед против
    //    голого носителя при соседях по школе в 50–68% и связка DEF на 95%.
    //
    // 2. Появился потолок за удар. Без него отражение тем сильнее, чем
    //    сильнее бьёт противник, то есть растёт вместе со всей прогрессией
    //    и с зонами. На первом уровне потолок не срабатывает — он и не
    //    должен: он ограничивает не сейчас, а дальше.
    hooks: {
      onTakeDamage: (ctx) => {
        const incoming = ctx.amount ?? 0;
        const share = incoming * num(ctx.balance, 'thorns', 'reflectFraction');
        const cap = num(ctx.balance, 'thorns', 'maxReflectPerHit');
        const reflected = Math.round(Math.min(share, cap));
        if (reflected <= 0 || ctx.opponent.hp <= 0) return [];

        const applied = Math.min(reflected, ctx.opponent.hp);
        ctx.opponent.hp -= applied;
        return [
          fired(ctx, 'thorns', `reflect ${applied}`),
          {
            t: 'damage',
            target: ctx.opponentIndex,
            amount: applied,
            crit: false,
            hpAfter: ctx.opponent.hp,
          },
        ];
      },
    },
  },
  {
    id: 'secondWind',
    school: 'def',
    anchor: true,
    hooks: {
      onTakeDamage: (ctx) => {
        if (ctx.state.fired > 0) return [];
        if (hpFraction(ctx.self) > num(ctx.balance, 'secondWind', 'hpThreshold')) return [];
        if (ctx.self.hp <= 0) return [];

        ctx.state.fired += 1;
        return [
          fired(ctx, 'secondWind'),
          ...inflict(ctx, 'self', 'regen', num(ctx.balance, 'secondWind', 'regenStacks')),
        ];
      },
    },
  },
  {
    id: 'bulwark',
    school: 'def',
    hooks: {
      onBattleStart: (ctx) => [
        fired(ctx, 'bulwark'),
        ...inflict(ctx, 'self', 'shield', num(ctx.balance, 'bulwark', 'shieldStacks')),
      ],
    },
  },
  {
    id: 'stoneskin',
    school: 'def',
    modify: ({ self, balance }) =>
      hpFraction(self) > num(balance, 'stoneskin', 'hpThreshold')
        ? { armorMultiplier: num(balance, 'stoneskin', 'armorMultiplier') }
        : {},
    hooks: {},
  },
  {
    id: 'retribution',
    school: 'def',
    hooks: {
      onTakeDamage: (ctx) =>
        ctx.crit === true
          ? [
              fired(ctx, 'retribution'),
              ...inflict(ctx, 'opponent', 'burn', num(ctx.balance, 'retribution', 'burnStacks')),
            ]
          : [],
    },
  },
  {
    id: 'hardened',
    school: 'def',
    modify: ({ balance }) => ({ armor: num(balance, 'hardened', 'armor') }),
    hooks: {},
  },
  {
    id: 'resolve',
    school: 'def',
    // Стан на себе короче вдвое: сокращаем длительность при наложении.
    hooks: {
      onTurnStart: (ctx) => {
        const factor = num(ctx.balance, 'resolve', 'stunDurationMultiplier');
        const events: BattleEvent[] = [];
        for (const inst of ctx.self.statuses) {
          if (inst.id !== 'stun' || inst.duration <= 1) continue;
          inst.duration = Math.max(1, Math.floor(inst.duration * factor));
          events.push(fired(ctx, 'resolve', `stun→${inst.duration}`));
        }
        return events;
      },
    },
  },
];

/* ─────────────────────────────── AGI ─────────────────────────────────── */

const AGI: readonly Trait[] = [
  {
    id: 'phantom',
    school: 'agi',
    anchor: true,
    // «10% полностью избежать удара, отдельный бросок ДО уклонения».
    // В v1.0 был заменён на fAgi × 1.2.
    modify: ({ balance }) => ({ avoidChance: num(balance, 'phantom', 'avoidChance') }),
    hooks: {},
  },
  {
    id: 'windup',
    school: 'agi',
    anchor: true,
    modify: ({ state, balance }) =>
      state.turns > 0 && state.turns % num(balance, 'windup', 'everyNTurns') === 0
        ? { outgoingDamageMultiplier: num(balance, 'windup', 'damageMultiplier') }
        : {},
    hooks: {
      onTurnStart: (ctx) => {
        ctx.state.turns += 1;
        return [];
      },
    },
  },
  {
    id: 'riposte',
    school: 'agi',
    anchor: true,
    // Взводится уклонением, срабатывает сразу: кровотечение на атакующего.
    hooks: {
      onTakeDamage: (ctx) => {
        if (ctx.amount !== undefined) return [];
        return [
          fired(ctx, 'riposte'),
          ...inflict(ctx, 'opponent', 'bleed', num(ctx.balance, 'riposte', 'bleedStacks')),
        ];
      },
    },
  },
  {
    id: 'quickstep',
    school: 'agi',
    modify: ({ balance }) => ({ spdMultiplier: num(balance, 'quickstep', 'spdMultiplier') }),
    hooks: {},
  },
  {
    id: 'deadeye',
    school: 'agi',
    modify: ({ balance }) => ({ accuracy: num(balance, 'deadeye', 'accuracy') }),
    hooks: {},
  },
  {
    id: 'bleedout',
    school: 'agi',
    hooks: {
      onHit: (ctx) =>
        ctx.crit === true
          ? [
              fired(ctx, 'bleedout'),
              ...inflict(ctx, 'opponent', 'bleed', num(ctx.balance, 'bleedout', 'bleedStacks')),
            ]
          : [],
    },
  },
  {
    id: 'slippery',
    school: 'agi',
    // Два эффекта, и второй появился по результатам матрицы §4.6.
    //
    // Множителя крита ОДНОГО не хватает, и это измерено, а не угадано:
    // крит противника при AGI 16 добавляет около 9% ожидаемого урона,
    // поэтому даже полное его подавление даёт потолок в 61.5% побед
    // при соседях по школе в 57–74%. Дальше двигать было нечего.
    //
    // Второй эффект выбран по смыслу трейта: «скользкий» — удары приходят
    // вскользь. Поле `incomingDamageMultiplier` уже есть, его использует
    // `innateGuard`; новой механики трейт не вводит.
    modify: ({ balance }) => ({
      enemyCritMultiplier: num(balance, 'slippery', 'enemyCritMultiplier'),
      incomingDamageMultiplier: 1 - num(balance, 'slippery', 'incomingReduction'),
    }),
    hooks: {},
  },
];

/* ─────────────────────────────── MAG ─────────────────────────────────── */

const MAG: readonly Trait[] = [
  {
    id: 'hexblade',
    school: 'mag',
    anchor: true,
    // «20% наложить хекс». В v1.0 был заменён на fAtk × 1.1.
    hooks: {
      onHit: (ctx) =>
        ctx.rng.chance(num(ctx.balance, 'hexblade', 'chance'))
          ? [
              fired(ctx, 'hexblade'),
              ...inflict(ctx, 'opponent', 'hex', num(ctx.balance, 'hexblade', 'hexStacks')),
            ]
          : [],
    },
  },
  {
    id: 'plaguebearer',
    school: 'mag',
    anchor: true,
    // Тот же бросок и по той же причине, что у `bloodlust`: безусловный
    // яд на каждом попадании брал 96% побед у своего же архетипа.
    hooks: {
      onHit: (ctx) =>
        ctx.rng.chance(num(ctx.balance, 'plaguebearer', 'chance'))
          ? [
              fired(ctx, 'plaguebearer'),
              ...inflict(
                ctx,
                'opponent',
                'poison',
                num(ctx.balance, 'plaguebearer', 'poisonStacks'),
              ),
            ]
          : [],
    },
  },
  {
    id: 'amplifier',
    school: 'mag',
    anchor: true,
    modify: ({ balance }) => ({ dotDamageBonus: num(balance, 'amplifier', 'dotDamageBonus') }),
    hooks: {},
  },
  {
    id: 'pyromancer',
    school: 'mag',
    hooks: {
      onHit: (ctx) =>
        ctx.crit === true
          ? [
              fired(ctx, 'pyromancer'),
              ...inflict(ctx, 'opponent', 'burn', num(ctx.balance, 'pyromancer', 'burnStacks')),
            ]
          : [],
    },
  },
  {
    id: 'leech',
    school: 'mag',
    hooks: {
      onHit: (ctx) => {
        const dealt = ctx.amount ?? 0;
        const healed = Math.round(dealt * num(ctx.balance, 'leech', 'healFraction'));
        if (healed <= 0) return [];
        const before = ctx.self.hp;
        ctx.self.hp = Math.min(ctx.self.maxHp, ctx.self.hp + healed);
        const gained = ctx.self.hp - before;
        return gained > 0 ? [fired(ctx, 'leech', `hp+${gained}`)] : [];
      },
    },
  },
  {
    id: 'frostbite',
    school: 'mag',
    hooks: {
      onHit: (ctx) =>
        ctx.rng.chance(num(ctx.balance, 'frostbite', 'chance'))
          ? [
              fired(ctx, 'frostbite'),
              ...inflict(ctx, 'opponent', 'chill', num(ctx.balance, 'frostbite', 'chillStacks')),
            ]
          : [],
    },
  },
  {
    id: 'siphon',
    school: 'mag',
    hooks: {
      onHit: (ctx) => {
        if (!ctx.rng.chance(num(ctx.balance, 'siphon', 'chance'))) return [];
        const idx = ctx.opponent.statuses.findIndex((s) => s.id === 'shield' || s.id === 'regen');
        if (idx < 0) return [];
        const [removed] = ctx.opponent.statuses.splice(idx, 1);
        if (removed === undefined) return [];
        return [
          fired(ctx, 'siphon', removed.id),
          {
            t: 'status_expire',
            target: ctx.opponentIndex,
            instance: removed.instance,
            status: removed.id,
            stacks: removed.stacks,
          },
        ];
      },
    },
  },
];

/* ────────────────────── врождённые, по причинам изгнания ─────────────── */

const INNATE: readonly Trait[] = [
  {
    id: 'innateThief',
    school: 'str',
    // «+5% урона за каждый последовательный удар без промаха».
    modify: ({ state, balance }) => ({
      outgoingDamageMultiplier:
        1 + state.stacks * num(balance, 'innateThief', 'damagePerConsecutiveHit'),
    }),
    hooks: {
      onHit: (ctx) => {
        const cap = num(ctx.balance, 'innateThief', 'maxStacks');
        ctx.state.stacks = Math.min(cap, ctx.state.stacks + 1);
        return [];
      },
      onBeforeAttack: (ctx) => {
        if (ctx.missed === true) ctx.state.stacks = 0;
        return [];
      },
    },
  },
  {
    id: 'innateGuard',
    school: 'def',
    // «Первый удар в бою получает −50% урона».
    modify: ({ state, balance }) =>
      state.fired === 0
        ? { incomingDamageMultiplier: 1 - num(balance, 'innateGuard', 'firstHitReduction') }
        : {},
    hooks: {
      onTakeDamage: (ctx) => {
        if (ctx.state.fired > 0) return [];
        ctx.state.fired += 1;
        return [fired(ctx, 'innateGuard')];
      },
    },
  },
  {
    id: 'innateAdvocate',
    school: 'agi',
    // «После уклонения следующий удар — гарантированный крит».
    //
    // Крит выдаётся ЗДЕСЬ, а не событием в хуке: хук `onHit` вызывается
    // уже после того, как урон посчитан, и события «сработало» без
    // изменения броска хватило бы ровно на то, чтобы описание разошлось
    // с поведением. Пайплайн читает `guaranteedCrit` на шаге 7.
    modify: ({ state }) => (state.armed ? { guaranteedCrit: true } : {}),
    hooks: {
      onTakeDamage: (ctx) => {
        // Уклонение приходит без числа урона.
        if (ctx.amount === undefined) ctx.state.armed = true;
        return [];
      },
      onHit: (ctx) => {
        if (!ctx.state.armed) return [];
        ctx.state.armed = false;
        return [fired(ctx, 'innateAdvocate')];
      },
    },
  },
  {
    id: 'innateScholar',
    school: 'mag',
    // «Наложенные статусы длятся на 1 тик дольше».
    hooks: {},
  },
];

/* ───────── трейты монстров: механики босса, GDD §7.5 ─────────── */

/**
 * Две механики, ломающие стандартный расчёт. Трейтами, а не ветками
 * в `resolve.ts`: там не упомянут по имени ни один трейт и ни один
 * статус, и `if (isBoss)` сломал бы ровно это свойство.
 *
 * В пул выбора игрока не входят: школа у них `monster`, и любой перебор
 * «трейты школы X» исключает их сам, без списка исключений, который
 * однажды забудут пополнить.
 */
const MONSTER: readonly Trait[] = [
  {
    id: 'bossEnrage',
    school: 'monster',
    anchor: true,
    // «Ниже 30% HP входит в enrage: +50% урона, −20% защиты».
    // Сам эффект — СУЩЕСТВУЮЩИЙ статус: заводить второй с теми же
    // числами значило бы держать одну правду в двух местах.
    hooks: {
      onTurnStart: (ctx) => {
        if (ctx.state.fired > 0) return [];
        if (hpFraction(ctx.self) > num(ctx.balance, 'bossEnrage', 'hpThreshold')) return [];

        ctx.state.fired += 1;
        return [fired(ctx, 'bossEnrage'), ...inflict(ctx, 'self', 'enrage', 1)];
      },
    },
  },
  {
    id: 'bossHeavyStrike',
    school: 'monster',
    anchor: true,
    /* Множитель встаёт в тот ход, который телеграф пообещал ходом раньше.
       Считается от ЧИСЛА СВОИХ ХОДОВ, а не от тиков: боец действует раз
       в ~8 тиков, и «раз в 8 тиков» из §7.5 означало бы «почти каждым
       ходом» — телеграф висел бы непрерывно и перестал бы что-либо
       сообщать. Документ исправлен, число здесь. */
    modify: ({ state, balance }) =>
      state.turns > 0 && state.turns % num(balance, 'bossHeavyStrike', 'everyNTurns') === 0
        ? { outgoingDamageMultiplier: num(balance, 'bossHeavyStrike', 'damageMultiplier') }
        : {},
    hooks: {
      onTurnStart: (ctx) => {
        ctx.state.turns += 1;
        return [];
      },

      /* ПРЕДУПРЕЖДЕНИЕ ИДЁТ ЗА ХОД ДО УДАРА, и выпускается оно В КОНЦЕ
         хода. Проверяется СЛЕДУЮЩИЙ ход, а не текущий: событие в том же
         ходу ничего бы не предсказывало.

         Конец, а не начало — потому что в начале хода строка вставала
         в журнале ВПЛОТНУЮ НАД обычным ударом того же хода, и читалась
         как подпись к нему: игрок видел «замахивается», следом −25 и
         решал, что тяжёлый удар уже случился. Механика была верна,
         показ — нет, а другого способа увидеть бой у игрока нет. */
      onTurnEnd: (ctx) => {
        const every = num(ctx.balance, 'bossHeavyStrike', 'everyNTurns');
        if ((ctx.state.turns + 1) % every === 0) {
          return [{ t: 'telegraph', actor: ctx.selfIndex, inTurns: 1 }];
        }
        return [];
      },
    },
  },
];

/* ─────────────────────────────── реестр ──────────────────────────────── */

const DEFINITIONS: readonly Trait[] = [...STR, ...DEF, ...AGI, ...MAG, ...INNATE, ...MONSTER];

export const TRAITS: ReadonlyMap<TraitId, Trait> = new Map(DEFINITIONS.map((t) => [t.id, t]));

export function traitDefinition(id: TraitId): Trait {
  const def = TRAITS.get(id);
  if (def === undefined) throw new Error(`трейт «${id}» объявлен, но не реализован`);
  return def;
}

export function createTraitState(): TraitState {
  return { fired: 0, stacks: 0, turns: 0, armed: false };
}

/* ──────────────────────── агрегация пассивов ─────────────────────────── */

/**
 * Сумма пассивных модификаторов всех трейтов бойца.
 *
 * Плоские прибавки складываются, множители перемножаются — обе операции
 * коммутативны, поэтому порядок трейтов на исход не влияет. Если однажды
 * появится некоммутативный модификатор, порядок придётся задать явно,
 * и это будет видно отсюда.
 *
 * Ничего не мутирует: `modify` у каждого трейта — чистая функция.
 */
export function activeTraitModifiers(
  self: FighterState,
  opponent: FighterState,
  balance: CombatBalance,
): TraitModifiers {
  let atk = 0;
  let agi = 0;
  let spd = 0;
  let armor = 0;
  let accuracy = 0;
  let atkMultiplier = 1;
  let armorMultiplier = 1;
  let spdMultiplier = 1;
  let avoidChance = 0;
  let blockReductionOverride: number | undefined;
  let armorPenetration = 0;
  let enemyCritMultiplier = 1;
  let outgoingDamageMultiplier = 1;
  let incomingDamageMultiplier = 1;
  let dotDamageBonus = 0;
  let guaranteedCrit = false;

  for (const id of self.config.traits) {
    const def = traitDefinition(id);
    if (def.modify === undefined) continue;

    const state = self.traitStates.get(id) ?? createTraitState();
    const m = def.modify({ self, opponent, balance, state });

    atk += m.atk ?? 0;
    agi += m.agi ?? 0;
    spd += m.spd ?? 0;
    armor += m.armor ?? 0;
    accuracy += m.accuracy ?? 0;
    atkMultiplier *= m.atkMultiplier ?? 1;
    armorMultiplier *= m.armorMultiplier ?? 1;
    spdMultiplier *= m.spdMultiplier ?? 1;
    avoidChance += m.avoidChance ?? 0;
    armorPenetration += m.armorPenetration ?? 0;
    enemyCritMultiplier *= m.enemyCritMultiplier ?? 1;
    outgoingDamageMultiplier *= m.outgoingDamageMultiplier ?? 1;
    incomingDamageMultiplier *= m.incomingDamageMultiplier ?? 1;
    dotDamageBonus += m.dotDamageBonus ?? 0;
    guaranteedCrit ||= m.guaranteedCrit ?? false;

    // Переопределение блока не складывается: берётся сильнейшее.
    // Два «блок гасит полностью» не дают двести процентов.
    if (m.blockReductionOverride !== undefined) {
      blockReductionOverride = Math.max(blockReductionOverride ?? 0, m.blockReductionOverride);
    }
  }

  const result: TraitModifiers = {
    atk,
    agi,
    spd,
    armor,
    accuracy,
    atkMultiplier,
    armorMultiplier,
    spdMultiplier,
    avoidChance: Math.min(1, avoidChance),
    armorPenetration: Math.min(1, armorPenetration),
    enemyCritMultiplier,
    outgoingDamageMultiplier,
    incomingDamageMultiplier,
    dotDamageBonus,
    guaranteedCrit,
  };

  return blockReductionOverride === undefined ? result : { ...result, blockReductionOverride };
}

/** Есть ли у бойца трейт, продлевающий наложенные им статусы (innateScholar). */
export function statusDurationBonus(self: FighterState, balance: CombatBalance): number {
  let bonus = 0;
  for (const id of self.config.traits) {
    if (id !== 'innateScholar') continue;
    bonus += num(balance, 'innateScholar', 'extraDuration');
  }
  return bonus;
}

/**
 * Вызвать хук у всех трейтов бойца.
 *
 * Единая точка: цикл боя не знает ни одного трейта по имени и не решает,
 * у кого какой хук есть.
 */
export function fireTraitHook(
  hook: keyof TraitHooks,
  base: Omit<TraitContext, 'state'>,
): readonly BattleEvent[] {
  const events: BattleEvent[] = [];

  for (const id of base.self.config.traits) {
    const def = traitDefinition(id);
    const fn = def.hooks[hook];
    if (fn === undefined) continue;

    let state = base.self.traitStates.get(id);
    if (state === undefined) {
      state = createTraitState();
      base.self.traitStates.set(id, state);
    }

    events.push(...fn({ ...base, state }));
  }

  return events;
}
