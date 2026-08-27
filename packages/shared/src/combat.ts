import { z } from 'zod';

/**
 * Контракт боевого движка. GDD §3.2, §4.
 *
 * Типы живут здесь, а не в `@extramundum/sim`, потому что этот же формат
 * потребляет рендер из M2 — а он исполняется в браузере, куда движок
 * не попадает никогда (инвариант 3). Движок импортирует эти типы через
 * `import type`: такой импорт стирается при компиляции и рантайм-ребра
 * не создаёт. Причина и подпорки — docs/adr/0003-tipy-kontrakta-v-shared.md.
 *
 * Здесь только форма данных. Ни одной формулы: формулы — в движке,
 * коэффициенты — в packages/data/balance.json (инвариант 5).
 */

/* ────────────────────────── классы снаряжения ────────────────────────── */

/** Класс оружия. GDD §4.3. */
export const WEAPON_CLASSES = ['light', 'balanced', 'heavy'] as const;
export const weaponClassSchema = z.enum(WEAPON_CLASSES);
export type WeaponClass = z.infer<typeof weaponClassSchema>;

/** Класс брони. GDD §4.3. */
export const ARMOR_CLASSES = ['cloth', 'light', 'medium', 'heavy'] as const;
export const armorClassSchema = z.enum(ARMOR_CLASSES);
export type ArmorClass = z.infer<typeof armorClassSchema>;

/* ──────────────────────────────── статусы ────────────────────────────── */

/**
 * Стартовый набор статусов. GDD §4.4.
 *
 * Порядок в этом массиве — КАНОНИЧЕСКИЙ порядок разрешения внутри одной
 * категории (см. `STATUS_ORDER` в движке). Он объявлен здесь, а не в
 * движке, потому что рендер обязан раскладывать иконки в том же порядке:
 * иначе одинаковый бой будет выглядеть по-разному.
 */
export const STATUS_IDS = [
  'bleed',
  'poison',
  'burn',
  'stun',
  'hex',
  'fury',
  'regen',
  'shield',
  'enrage',
  'chill',
] as const;
export const statusIdSchema = z.enum(STATUS_IDS);
export type StatusId = z.infer<typeof statusIdSchema>;

/* ──────────────────────────────── трейты ────────────────────────────── */

/**
 * Школы трейтов. GDD §4.5: пул разбит по четырём школам, у каждой
 * 2–3 якорных трейта, вокруг которых строится билд.
 */
export const TRAIT_SCHOOLS = ['str', 'def', 'agi', 'mag'] as const;
export const traitSchoolSchema = z.enum(TRAIT_SCHOOLS);
export type TraitSchool = z.infer<typeof traitSchoolSchema>;

/**
 * Выбираемые трейты. GDD §4.5: пул расширяется до ~30.
 *
 * Порядок — по школам, внутри школы якорные первыми. Шесть трейтов
 * из аудита v1.0 (§13, пункт 3) реализованы в первую очередь: `warlord`,
 * `cursed`, `fortress`, `thorns`, `phantom`, `hexblade`.
 */
export const TRAIT_IDS = [
  // STR — урон и риск
  'warlord',
  'cursed',
  'executioner',
  'bloodlust',
  'berserker',
  'overpower',
  'ironGrip',
  'butcher',

  // DEF — выживание
  'fortress',
  'thorns',
  'secondWind',
  'bulwark',
  'stoneskin',
  'retribution',
  'hardened',
  'resolve',

  // AGI — темп и уклонение
  'phantom',
  'windup',
  'riposte',
  'quickstep',
  'deadeye',
  'bleedout',
  'slippery',

  // MAG — статусы
  'hexblade',
  'plaguebearer',
  'amplifier',
  'pyromancer',
  'leech',
  'frostbite',
  'siphon',
] as const;

/**
 * Врождённые трейты причин изгнания. GDD §5.1.
 *
 * Не входят в пул выбора: их нельзя взять на уровне, они приходят
 * с прошлым персонажа и остаются навсегда.
 */
export const INNATE_TRAIT_IDS = [
  'innateThief',
  'innateGuard',
  'innateAdvocate',
  'innateScholar',
] as const;

/**
 * Трейты МОНСТРОВ. GDD §7.5.
 *
 * Две механики босса — вход в `enrage` ниже порога HP и телеграфированный
 * тяжёлый удар — сделаны трейтами, а не ветками в `resolve.ts`. Причина
 * та же, по которой там не упомянут по имени ни один статус: реестр
 * хуков уже есть и покрыт тестами, а `if (isBoss)` в цикле боя сломал бы
 * ровно то свойство, ради которого реестр писался.
 *
 * В пул выбора игрока не входят — как и врождённые. Отличаются от них
 * тем, что игроку недоступны вовсе: врождённый приходит с прошлым
 * персонажа, а эти принадлежат противнику.
 */
export const MONSTER_TRAIT_IDS = ['bossEnrage', 'bossHeavyStrike'] as const;

export const ALL_TRAIT_IDS = [...TRAIT_IDS, ...INNATE_TRAIT_IDS, ...MONSTER_TRAIT_IDS] as const;
export const traitIdSchema = z.enum(ALL_TRAIT_IDS);
export type TraitId = z.infer<typeof traitIdSchema>;

/**
 * Причины изгнания. GDD §5.1: игрок выбирает не класс, а прошлое.
 * Каждая даёт стартовые статы и один врождённый трейт.
 */
export const ARCHETYPE_IDS = ['theft', 'brawl', 'advocacy', 'forbidden'] as const;
export const archetypeIdSchema = z.enum(ARCHETYPE_IDS);
export type ArchetypeId = z.infer<typeof archetypeIdSchema>;

/* ──────────────────────────── конфигурация бойца ─────────────────────── */

export const weaponConfigSchema = z.object({
  /** Урон оружия. Эти числа участвуют в расчёте НАПРЯМУЮ (GDD §4.2). */
  dmgMin: z.number().min(0),
  dmgMax: z.number().min(0),
  /** Уровень предмета: масштабирует базу, GDD §6.1. */
  ilvl: z.int().min(1),
  class: weaponClassSchema,
});
export type WeaponConfig = z.infer<typeof weaponConfigSchema>;

/**
 * Оффхенд. GDD §5.3: щит, второе оружие или фокус — ТРИ РАЗНЫХ ТИПА,
 * а не три варианта одного.
 *
 * Размеченное объединение, а не общий объект с необязательными полями:
 * «щит с уроном» и «фокус с блоком» не должны выражаться в типе вовсе.
 * В M1a был только щит, остальное появилось с предметами (M3a).
 *
 * ⚠️ Число бросков за удар от типа оффхенда НЕ ЗАВИСИТ. Блок бросается
 * безусловно у всех, второе оружие складывает урон в тот же бросок,
 * фокус не бросает вовсе. Иначе два билда, отличающиеся оффхендом,
 * расходились бы ПОТОКОМ генератора, и матрица винрейтов мерила бы
 * смещение выборки вместо силы правки. На это есть тест.
 */
export const offhandConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('shield'),
    blockChance: z.number().min(0).max(1),
    /** Насколько блок гасит урон: 0.6–1.0 (GDD §4.2). */
    blockReduction: z.number().min(0).max(1),
  }),
  z.object({
    kind: z.literal('weapon'),
    /** Складывается с уроном основного оружия в ТОТ ЖЕ бросок. */
    dmgMin: z.number().min(0),
    dmgMax: z.number().min(0),
  }),
  z.object({
    kind: z.literal('focus'),
    /** Множитель силы статусов, наложенных НОСИТЕЛЕМ. 1.25 = +25%. */
    statusPower: z.number().min(1),
  }),
]);
export type OffhandConfig = z.infer<typeof offhandConfigSchema>;

/**
 * Доли по каждому процентному семейству. Пустой список — семейства нет.
 *
 * Ключи перечислены явно, а не выведены из `PERCENT_AFFIX_FAMILIES`:
 * `z.record` по литеральному объединению не даёт умолчаний по ключам,
 * а без них любой конфиг бойца пришлось бы заполнять целиком — включая
 * спарринг-манекен и монстров, у которых аффиксов нет вовсе.
 */
export const percentAffixesSchema = z
  .object({
    might: z.array(z.number()).default([]),
    bastion: z.array(z.number()).default([]),
    swiftness: z.array(z.number()).default([]),
  })
  .default({ might: [], bastion: [], swiftness: [] });
export type PercentAffixes = z.infer<typeof percentAffixesSchema>;

export const fighterConfigSchema = z.object({
  level: z.int().min(1),

  /** Четыре базовые характеристики. GDD §3.3. Пятой нет и не будет. */
  atk: z.number().min(0),
  def: z.number().min(0),
  agi: z.number().min(0),
  spd: z.number().min(0),

  /**
   * Бонусы HP от путей уровня. ОТДЕЛЬНОЕ ПОЛЕ, а не пересчёт из уровня.
   *
   * В v1.0 `applyEquippedToFighter` считал максимум HP по формуле заново
   * и молча стирал бонусы путей GUARDIAN, IRON и TITAN — три билда
   * из десяти не работали (GDD §13, пункт 2). Поэтому хранится здесь
   * и складывается с формулой, а не выводится из неё.
   */
  pathBonusHp: z.number().min(0).default(0),

  /**
   * Бонусы HP ОТ СНАРЯЖЕНИЯ — семейство «Жила» (M3b).
   *
   * ОТДЕЛЬНОЕ поле, а не прибавка к `pathBonusHp`. Смешать два источника
   * в одном числе — это и есть форма бага v1.0 из §13 пункта 2: там
   * максимум HP пересчитывался из уровня и молча стирал бонусы путей.
   * Пока источники раздельны, снятый предмет уносит ровно своё, а путь
   * остаётся путём.
   */
  gearBonusHp: z.number().min(0).default(0),

  /**
   * Точность. Производная величина из экипировки, не базовый стат
   * (GDD §4.2). Без соответствующих аффиксов — ноль.
   */
  accuracy: z.number().min(0).default(0),

  /** Суммарная броня со всех слотов. */
  armor: z.number().min(0).default(0),
  armorClass: armorClassSchema,

  /** Прибавка к шансу крита от аффиксов, сверх формулы от AGI. */
  critBonus: z.number().min(0).default(0),

  /**
   * HP, с которым боец ВХОДИТ в бой. По умолчанию — максимум.
   *
   * Нужно рейду: «HP восстанавливается на 25% между боями, не полностью»
   * (§7.2). Без этого поля второй бой забега начинался бы с полного
   * запаса, и перенос HP — то, на чём держится решение «идти дальше» —
   * не существовал бы.
   *
   * Поле КОНФИГУРАЦИИ, а не аргумент `resolveBattle`: это свойство
   * бойца, как его статы, и оно обязано ехать вместе с ним — в том числе
   * в снапшот арены и в эталонный лог. Аргументом оно бы потерялось
   * при первой же передаче конфигурации в другую функцию.
   *
   * Значение выше максимума молча зажимается: максимум считает движок,
   * и сервер не обязан знать формулу, чтобы передать сюда «сколько было».
   */
  startHp: z.number().positive().nullable().default(null),

  weapon: weaponConfigSchema,
  /** null — оффхенд пуст. */
  offhand: offhandConfigSchema.nullable().default(null),

  /**
   * Процентные семейства аффиксов — СПИСКАМИ долей, а не свёрнутыми
   * множителями. GDD §6.1 для «Мощи», M3b для остальных.
   *
   * Список принципиален: бюджет семейства (сколько сильнейших
   * учитывается) держит ДВИЖОК. Приди сюда готовый множитель, правило
   * жило бы на сервере, где его нечем проверить тестом, — а механики
   * без теста не существует.
   *
   * Плоских семейств здесь нет: они складываются в свой стат ещё
   * при сборке бойца (`strength` → `atk`, `fortitude` → `armor`,
   * `truehand` → `accuracy`, `vitality` → `gearBonusHp`). Сумма
   * коммутативна и бюджета не требует, поэтому и списка не требует.
   */
  percentAffixes: percentAffixesSchema,

  /**
   * Статусы, с которыми боец входит в бой.
   *
   * В M1b это единственный способ их выдать: трейты (M1c) и предметы
   * с эффектами (M3) появятся позже. Поле нужно и потом — босс входит
   * в бой уже под `enrage`, зона может накладывать эффект на входе.
   */
  statuses: z
    .array(
      z.object({
        id: statusIdSchema,
        stacks: z.int().min(1),
        /** -1 — до конца боя. */
        duration: z.int().min(-1),
      }),
    )
    .default([]),

  /**
   * Трейты бойца. GDD §4.5.
   *
   * Один список и для выбранных на уровнях, и для врождённого трейта
   * причины изгнания: движку незачем их различать, разница только
   * в том, кто их туда положил.
   */
  traits: z.array(traitIdSchema).default([]),
});
export type FighterConfig = z.infer<typeof fighterConfigSchema>;

/** Двое бойцов: индекс в этом кортеже и есть `actor` в событиях лога. */
export const battleSetupSchema = z.tuple([fighterConfigSchema, fighterConfigSchema]);
export type BattleSetup = z.infer<typeof battleSetupSchema>;

/* ──────────────────────────── коэффициенты ───────────────────────────── */

/**
 * Срез balance.json, который нужен движку.
 *
 * Движок не читает файлов (инвариант 2) — коэффициенты приходят
 * аргументом. Схема существует, чтобы сервер проверил их один раз
 * при загрузке, а не ловил `undefined` посреди боя.
 */
/**
 * Отбросить пояснительные ключи balance.json.
 *
 * В файле у каждого блока есть `$source`, `$note` и пометка
 * `calibration` — они для человека, а не для движка. `z.object`
 * отбрасывает лишнее сам, а `z.record` обязан описать ВСЕ ключи,
 * поэтому для записей это делается здесь.
 */
function dropMeta(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([key]) => !key.startsWith('$') && key !== 'calibration',
    ),
  );
}

const matchupRowSchema = z.object({
  cloth: z.number(),
  light: z.number(),
  medium: z.number(),
  heavy: z.number(),
});

/** Периодический урон: три эффекта с одинаковой формой (bleed/poison/burn). */
const dot = z.object({
  damagePerStack: z.number(),
  duration: z.int(),
  tickEvery: z.int().min(1),
  maxStacks: z.int().min(1),
});

export const combatBalanceSchema = z.object({
  damage: z.object({
    atkDivisor: z.number().positive(),
    critMultiplier: z.number().positive(),
    mitigation: z.object({
      armorConstant: z.number(),
      armorPerAttackerLevel: z.number(),
      cap: z.number().min(0).max(1),
    }),
  }),
  dodge: z.object({
    base: z.number(),
    perAgiOverAccuracy: z.number(),
    min: z.number().min(0).max(1),
    max: z.number().min(0).max(1),
  }),
  crit: z.object({
    base: z.number(),
    perAgi: z.number(),
    cap: z.number().min(0).max(1),
  }),
  block: z.object({
    chanceMin: z.number().min(0).max(1),
    chanceMax: z.number().min(0).max(1),
    reductionMin: z.number().min(0).max(1),
    reductionMax: z.number().min(0).max(1),
  }),
  maxHp: z.object({
    base: z.number(),
    perDef: z.number(),
    perLevel: z.number(),
  }),
  // Явные ключи, а не z.record: классы фиксированы, а забытая клетка
  // должна валить загрузку баланса, а не всплывать посреди боя.
  // Пояснительные поля `$source` и `$note` из balance.json отбрасываются.
  matchup: z.object({
    light: matchupRowSchema,
    balanced: matchupRowSchema,
    heavy: matchupRowSchema,
  }),
  items: z.object({
    ilvlScale: z.number(),
    /**
     * Сколько аффиксов каждого ПРОЦЕНТНОГО семейства учитывается в бою.
     * GDD §6.1 для «Мощи», замер M3b для остальных.
     *
     * Правило держит ДВИЖОК, а не сервер и не генератор: надеть можно
     * сколько угодно, считаются N сильнейших. На генерации это
     * невыразимо — предмет создаётся, не зная, кто его наденет,
     * — а на сервере было бы механикой без теста.
     *
     * Число на семейство, а не одно на всех: у «Мощи» бюджет проверен
     * замером и равен двум, у остальных свои числа и свои замеры.
     */
    familyBudget: z.object({
      might: z.int().min(1),
      bastion: z.int().min(1),
      swiftness: z.int().min(1),
    }),
  }),

  /**
   * Коэффициенты статусов. GDD §4.4 задаёт систему и набор эффектов,
   * но НЕ ДАЁТ НИ ОДНОГО ЧИСЛА — кроме enrage в §7.5. Всё остальное
   * назначено при реализации и помечено в balance.json как ожидающее
   * калибровки: их выверит матрица винрейтов §4.6, то есть M1c.
   */
  statuses: z.object({
    /** Кап экземпляров одного статуса на бойце. Защита от бесконечного стака. */
    maxInstances: z.int().positive(),
    // `tickEvery` — период в тиках. Он обязателен, а не опционален
    // с умолчанием: единица означала бы «каждый тик», а это в десять
    // раз сильнее удара, и забытое поле молча вернуло бы тот перекос.
    // `maxStacks` обязателен у всех десяти: обновляемым эффектам он
    // единственная защита от накопления, а `maxInstances` их не касается.
    bleed: dot,
    poison: dot,
    burn: dot,
    regen: z.object({
      healPerStack: z.number(),
      duration: z.int(),
      tickEvery: z.int().min(1),
      maxStacks: z.int().min(1),
    }),
    stun: z.object({ duration: z.int(), maxStacks: z.int().min(1) }),
    shield: z.object({
      absorbPerStack: z.number(),
      duration: z.int(),
      maxStacks: z.int().min(1),
    }),
    hex: z.object({ atkPerStack: z.number(), duration: z.int(), maxStacks: z.int().min(1) }),
    fury: z.object({ atkPerStack: z.number(), duration: z.int(), maxStacks: z.int().min(1) }),
    chill: z.object({ spdPerStack: z.number(), duration: z.int(), maxStacks: z.int().min(1) }),
    enrage: z.object({
      /** Прибавка к множителю атаки: 0.5 значит ×1.5 урона (GDD §7.5). */
      attackMultiplierBonus: z.number(),
      /** Множитель брони: 0.8 значит −20% защиты (GDD §7.5). */
      armorMultiplier: z.number(),
      duration: z.int(),
      maxStacks: z.int().min(1),
    }),
  }),
  tick: z.object({
    initiativeThreshold: z.number().positive(),
    limit: z.int().positive(),
    /**
     * Нижняя граница SPD. Замедленный боец обязан продолжать ходить.
     *
     * Ноль означал бы вечную заморозку — контроль без выхода, ровно то,
     * от чего GDD §4.4 защищает стан жёстким правилом. Без этой границы
     * `chill`, накладываемый каждым ударом, уводил SPD цели в ноль,
     * и трейт `frostbite` брал сто процентов побед.
     */
    minSpd: z.number().positive(),
  }),

  /**
   * Коэффициенты трейтов. GDD §4.5 задаёт шесть аудитных поимённо
   * с числами; остальные спроектированы при реализации M1c и помечены
   * в balance.json как ожидающие калибровки.
   *
   * Схема плоская: у каждого трейта свой набор полей, и общего
   * знаменателя у «отражает 15%» и «каждый третий ход ×1.6» нет.
   */
  traits: z.preprocess(dropMeta, z.record(z.string(), z.record(z.string(), z.number()))),

  /**
   * Стартовые статы причин изгнания. GDD §5.1 описывает их словами
   * («сбалансированный», «DEF/HP», «AGI/SPD», «MAG»), но чисел не даёт.
   * Назначены при реализации, выверяются матрицей винрейтов §4.6.
   */
  archetypes: z.preprocess(
    dropMeta,
    z.record(
      z.string(),
      z.object({
        atk: z.number(),
        def: z.number(),
        agi: z.number(),
        spd: z.number(),
        accuracy: z.number(),
        armor: z.number(),
        trait: traitIdSchema,
      }),
    ),
  ),
});
export type CombatBalance = z.infer<typeof combatBalanceSchema>;

/* ────────────────────────────── боевой лог ───────────────────────────── */

/** Индекс бойца. 0 и 1 — позиции в `BattleSetup`. */
export type ActorIndex = 0 | 1;

/**
 * Вид действия. В M1a есть только обычный удар: приёмы, способности
 * и реакции появятся вместе со статусами и трейтами.
 */
export const MOVE_KINDS = ['basic'] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

/**
 * Полный разбор броска. GDD §3.2: «клиент показывает их в тултипе
 * журнала боя».
 *
 * Здесь лежат ВСЕ промежуточные числа, а не только итог. Это не отладка,
 * а единственное, что есть у игрока в автобаттлере: вмешаться он не может,
 * значит должен хотя бы понимать, откуда взялась цифра. Поле, которое
 * не попало сюда, для игрока не существует.
 *
 * Произведение полей должно давать `final` — на это есть тест.
 */
export type RollBreakdown = {
  /** Шаг 3: бросок урона оружия до масштабирования по ilvl. */
  readonly weaponRoll: number;
  /** Шаг 3: множитель уровня предмета, 1 + ilvl × коэффициент (GDD §6.1). */
  readonly ilvlScale: number;
  /** Шаг 4: 1 + ATK / делитель. */
  readonly atkMultiplier: number;
  /**
   * Шаг 4: множитель семейства «Мощь». GDD §6.1.
   *
   * ОТДЕЛЬНЫМ ПОЛЕМ, а не внутри `atkMultiplier`. Смешавшись с ним,
   * «Мощь» заставила бы журнал врать ровно там, ради чего он написан:
   * игрок увидел бы одно число вместо двух и не понял бы, что из него
   * пришло от статов, а что от снаряжения.
   *
   * Учтены только две сильнейшие — бюджет семейства. Аффикс сверх
   * бюджета в этот множитель не входит, и превью обязано это показать.
   */
  readonly mightMultiplier: number;
  /** Шаг 5: «класс оружия × класс брони» (GDD §4.3). */
  readonly matchupMultiplier: number;
  /** Шаг 6: доля поглощённого бронёй урона, 0..кап. */
  readonly mitigation: number;
  /** Шаг 7: множитель крита либо 1. */
  readonly critMultiplier: number;
  /** Шаг 2: доля, снятая блоком, либо 0. */
  readonly blockReduction: number;
  /** Итог после всех шагов, округлённый. */
  readonly final: number;
};

/**
 * Идентификаторы статусов и трейтов. GDD §4.4 и §4.5.
 *
 * Объявлены сейчас, реализация — M1b и M1c. Причина: события ссылаются
 * на них, а формат лога — контракт с рендером. Добавить вариант в union
 * позже дешевле, чем поменять форму события, когда рендер уже написан.
 */

/**
 * Номер экземпляра статуса, уникальный в пределах боя.
 *
 * Кровотечение и яд стакаются НЕЗАВИСИМЫМИ экземплярами (GDD §4.4):
 * два наложения — это две записи со своими таймерами, а не одна
 * с обновлённой длительностью. Без номера рендер не свяжет
 * `status_apply` с его же `status_expire` и не поймёт, какая из двух
 * иконок погасла.
 *
 * `stacks` в событиях относится к ЭТОМУ экземпляру, а не к сумме
 * по идентификатору: сумму рендер сложит сам, разложить её обратно
 * он бы не смог.
 */
export type StatusInstanceId = number;

/**
 * Событие боевого лога. GDD §3.2.
 *
 * `status_*` и `trait_fire` зарезервированы: движок их пока не порождает,
 * но рендер из M2 должен уметь их принять с первого дня, иначе M1b
 * и M1c сломают уже написанный проигрыватель.
 */
export type BattleEvent =
  | { readonly t: 'turn_start'; readonly actor: ActorIndex; readonly tick: number }
  | {
      readonly t: 'attack';
      readonly actor: ActorIndex;
      readonly move: MoveKind;
      readonly roll: RollBreakdown;
    }
  | { readonly t: 'dodge'; readonly actor: ActorIndex; readonly mitigated: number }
  | { readonly t: 'block'; readonly actor: ActorIndex; readonly mitigated: number }
  | {
      readonly t: 'damage';
      readonly target: ActorIndex;
      readonly amount: number;
      readonly crit: boolean;
      readonly hpAfter: number;
    }
  | {
      readonly t: 'status_apply';
      readonly target: ActorIndex;
      readonly instance: StatusInstanceId;
      readonly status: StatusId;
      readonly stacks: number;
      /** В тиках. -1 — до конца боя. */
      readonly duration: number;
    }
  | {
      readonly t: 'status_tick' | 'status_expire';
      readonly target: ActorIndex;
      readonly instance: StatusInstanceId;
      readonly status: StatusId;
      readonly stacks: number;
      /**
       * Сколько эффект дал урона или лечения в этот тик. Игрок должен
       * видеть «яд снял 7», а не «яд сработал» — тот же принцип, что
       * и в `RollBreakdown`. У `status_expire` поля нет.
       */
      readonly amount?: number;
    }
  | {
      readonly t: 'trait_fire';
      readonly actor: ActorIndex;
      readonly trait: TraitId;
      readonly note?: string;
    }
  | {
      /**
       * ТЕЛЕГРАФ ТЯЖЁЛОГО УДАРА. GDD §7.5.
       *
       * Появляется в логе ЗА ХОД ДО нанесения, и в этом вся механика:
       * игрок не может отреагировать в бою, но обязан увидеть, что удар
       * был предсказуем, — тогда поражение читается как «нужен был другой
       * билд», а не как несправедливость.
       *
       * Отдельное событие, а не `trait_fire` с примечанием: журнал обязан
       * поставить строку ДО удара и оформить её иначе, чем срабатывание
       * трейта, а рендер — сыграть предупреждение, а не вспышку урона.
       */
      readonly t: 'telegraph';
      readonly actor: ActorIndex;
      /** Через сколько СВОИХ ходов ударит. Всегда 1: предупреждение одно. */
      readonly inTurns: number;
    }
  | { readonly t: 'death'; readonly actor: ActorIndex };

/**
 * Лог боя — последовательность событий, а не итог (GDD §3.2). Итог
 * хранится отдельно, в `battles.result`; из лога его можно вывести,
 * но лог не обязан его дублировать.
 */
export type BattleLog = {
  readonly version: number;
  /** Сид, из которого бой воспроизводится побитово. */
  readonly seed: string;
  readonly events: readonly BattleEvent[];
};

/** Итог боя. Возвращается движком рядом с логом, в сам лог не входит. */
export type BattleOutcome = {
  /** null — бой упёрся в лимит тиков и не завершился. */
  readonly winner: ActorIndex | null;
  readonly ticks: number;
  readonly hpRemaining: readonly [number, number];
};

export type BattleResult = {
  readonly log: BattleLog;
  readonly outcome: BattleOutcome;
};
