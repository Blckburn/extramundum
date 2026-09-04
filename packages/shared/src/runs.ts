import { z } from 'zod';

import { difficultySchema, zoneIdSchema } from './battle.js';
import type { armorClassSchema, weaponClassSchema, BattleLog, BattleOutcome } from './combat.js';
import type { ItemView } from './items.js';

/**
 * Забег с эвакуацией. GDD §7.2, §7.3.
 *
 * «Это превращает автобаттлер в игру про оценку риска. Игрок смотрит
 * на свой HP, на превью следующего врага, на матчап и решает. И это
 * решение он принимает САМ — единственное настоящее решение, которое
 * автобаттлер может дать в момент игры.»
 *
 * ВСЁ СОСТОЯНИЕ ЗАБЕГА ЖИВЁТ НА СЕРВЕРЕ. Клиент не присылает ни одного
 * числа: ни HP, ни содержимого сумки, ни того, кто следующий. Схемы
 * запросов ниже таких полей не содержат вовсе — подменить нечем.
 */

/* ──────────────────────────────── запросы ────────────────────────────── */

export const runStartInputSchema = z.object({
  zone: zoneIdSchema,
  /**
   * Номер участка, 0..3. GDD §7.4 в редакции после тупика.
   *
   * Это ЕДИНСТВЕННОЕ, что клиент говорит про силу противников, и оно
   * не число, а выбор из четырёх: уровень врага сервер берёт из данных
   * участка. Принимать уровень значило бы дать выбрать себе врага.
   */
  segment: z.int().min(0).max(3),
  difficulty: difficultySchema,
});
export type RunStartInput = z.infer<typeof runStartInputSchema>;

/**
 * У боя, зелья и эвакуации ТЕЛА НЕТ.
 *
 * Всё, что нужно, сервер знает сам: чей забег — из сессии, какой бой
 * следующий — из `fight_index`. Принимать номер боя от клиента значило бы
 * дать ему выбрать, какой бой провести, — то есть переиграть смерть.
 */
export const emptyInputSchema = z.object({}).strict();

/* ──────────────────────────── состояние забега ───────────────────────── */

/** Кто ждёт в следующем бою. GDD §7.2: «игрок смотрит на превью врага». */
export type NextEnemy = {
  /** Ключ монстра. Имя берёт локаль — `monster.<key>`. */
  readonly key: string;
  readonly level: number;
  readonly armorClass: z.infer<typeof armorClassSchema>;
  readonly weaponClass: z.infer<typeof weaponClassSchema>;
  readonly boss: boolean;
  /**
   * Множитель «класс оружия игрока × класс брони врага». GDD §4.3.
   *
   * Считает СЕРВЕР и отдаёт числом: «⚔ Твой молот против его кожи: ×0.90»
   * из документа — это плашка с готовым числом, а не приглашение клиенту
   * умножать самому.
   */
  readonly matchup: number;
};

export const RUN_STATES = ['active', 'extracted', 'wiped'] as const;
export type RunState = (typeof RUN_STATES)[number];

export type RunView = {
  readonly runId: string;
  readonly zone: z.infer<typeof zoneIdSchema>;
  readonly difficulty: z.infer<typeof difficultySchema>;
  /** На каком участке идёт забег, 0..3. */
  readonly segment: number;
  /** Границы уровней этого участка. Показывается в панели забега. */
  readonly segmentLevels: readonly [number, number];
  readonly state: RunState;
  /** Сколько боёв ПРОЙДЕНО: 0..5. */
  readonly fightIndex: number;
  readonly fightsTotal: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly potionsLeft: number;
  /**
   * Что уже лежит в сумке.
   *
   * Показывается целиком, и это по документу: «содержимое сумки игроку
   * известно: он видел, как падал лут». Скрывать её значило бы убрать
   * из решения «идти дальше» половину ставки.
   */
  readonly bag: readonly ItemView[];
  /** Множитель лута на СЛЕДУЮЩИЙ бой. GDD §7.2. */
  readonly lootMultiplier: number;
  /** Доля запаса, возвращаемая между боями в ЭТОЙ зоне. §7.2. */
  readonly hpRestore: number;
  /** `null`, если забег окончен. */
  readonly next: NextEnemy | null;
  /**
   * Можно ли эвакуироваться прямо сейчас. GDD §7.2: после боёв 2, 3 и 4.
   *
   * Решает СЕРВЕР и присылает готовым: правило «после второго, третьего
   * и четвёртого» на клиенте было бы вторым местом, где оно живёт.
   */
  readonly canExtract: boolean;
};

/* ──────────────────────────────── ответы ─────────────────────────────── */

/** Что бой дал игроку. Всё уже применено к профилю. */
export type FightRewards = {
  readonly xp: number;
  readonly gold: number;
  /** Что упало в сумку ЭТИМ боем. Уже входит в `run.bag`. */
  readonly loot: readonly ItemView[];
};

export type RunFightResponse = {
  readonly battleId: string;
  readonly log: BattleLog;
  readonly outcome: BattleOutcome;
  readonly maxHp: readonly [number, number];
  /** Против кого дрались. Ключ монстра, имя берёт локаль. */
  readonly enemy: string;
  /**
   * Как противник выглядит: ключ силуэта и подмена цветов палитры.
   *
   * Отдаётся ГОТОВЫМ, потому что `monsters.json` в браузер не попадает:
   * клиенту незачем знать статы, броню и таблицу дропа двадцати
   * монстров ради одной формы на экране.
   */
  readonly enemyLook: {
    readonly rig: string;
    readonly recolor?: Readonly<Record<string, string>>;
  };
  readonly rewards: FightRewards;
  /**
   * Состояние ПОСЛЕ боя. Смерть видна здесь: `state: 'wiped'`, сумка
   * пуста. Отменить это клиенту нечем — второго запроса на тот же бой
   * не существует.
   */
  readonly run: RunView;
};

export type RunResponse = { readonly run: RunView | null };

/** Итог эвакуации. GDD §7.2: «сумка целиком уходит в инвентарь». */
export type RunExtractResponse = {
  readonly run: RunView;
  /** Сколько предметов доехало до инвентаря. */
  readonly recovered: number;
};

/* ──────────────────────── доступные зоны на входе ────────────────────── */

/**
 * Карточка зоны для экрана выбора. GDD §7.3, §7.4.
 *
 * Всё считает сервер: границы участков, замки, множитель матчапа
 * по §4.3. Клиент рисует готовые числа — иначе формула жила бы
 * в двух местах и разошлась.
 */

/**
 * Участок зоны на карточке.
 *
 * УРОВЕНЬ ВРАГА ЗДЕСЬ — ДИАПАЗОН, А НЕ ЧИСЛО, и это не украшение:
 * внутри участка уровень разыгрывается броском, поэтому одно число
 * врало бы про половину боёв. Ровно тот же диапазон получает добыча —
 * ilvl равен уровню монстра.
 */
export type SegmentCard = {
  readonly index: number;
  readonly levels: readonly [number, number];
  /**
   * Открыт ли участок. Считает СЕРВЕР той же функцией, которой
   * откажет в старте забега: замок только на карточке обходится одним
   * запросом мимо интерфейса.
   */
  readonly unlocked: boolean;
  /** Пройден ли (убит босс). Открывает следующий. */
  readonly cleared: boolean;
};

export type ZoneCard = {
  readonly id: z.infer<typeof zoneIdSchema>;
  /** Диапазон зоны целиком. Подпись на карточке; участки лежат внутри. */
  readonly levels: readonly [number, number];
  /** Преобладающий класс брони или `mixed`. */
  readonly armorClass: string;
  /** Четыре участка с их уровнями и замками. */
  readonly segments: readonly SegmentCard[];
  /** Что даёт каждая сложность. Уровень она НЕ двигает — только силу и добычу. */
  readonly difficulties: Readonly<
    Record<
      z.infer<typeof difficultySchema>,
      {
        /**
         * Множитель числа предметов. Константа тира и ничего сверху:
         * затухание по разнице уровней снято вместе с самой разницей.
         */
        readonly lootMultiplier: number;
        /**
         * Насколько тир усиливает врага. GDD §7.3.
         *
         * Показывается игроку ВМЕСТО разницы в уровне: тир уровень
         * не двигает (он оказался негодной единицей — шаг стоил то
         * ноль, то шестьдесят восемь пунктов винрейта), и без этого
         * числа «опасная» отличалась бы от «обычной» только подписью.
         */
        readonly power: number;
      }
    >
  >;
  /** Ключи монстров зоны — чтобы показать, кого там встретишь. */
  readonly monsters: readonly string[];
  readonly boss: string;
  /** Множитель оружия игрока против преобладающей брони. `null` — зона смешанная. */
  readonly matchup: number | null;
  /**
   * Открыта ли зона вообще, то есть открыт ли её первый участок.
   *
   * ОТПИРАЕТСЯ ПРОХОЖДЕНИЕМ, А НЕ УРОВНЕМ. Прежний замок по уровню
   * игрока существовал затем, чтобы переросший не фармил «Кошмар»
   * в первой зоне за полную цену. Это было следствием того, что уровень
   * врага ехал за игроком; он больше не едет, и замок остался бы
   * без причины.
   */
  readonly unlocked: boolean;
  /**
   * Доля запаса, возвращаемая между боями. §7.2.
   *
   * ПОКАЗЫВАЕТСЯ НА КАРТОЧКЕ, потому что это вход в решение «идти
   * дальше», а не служебное число. И приходит от сервера, потому что
   * величина зонная: подпись «между боями четверть», написанная
   * в клиенте один раз на все зоны, врала бы на первой же из них.
   */
  readonly hpRestore: number;
};

export type ZonesResponse = {
  readonly zones: readonly ZoneCard[];
  /** Идёт ли уже забег: тогда новый начать нельзя. */
  readonly activeRun: RunView | null;
};
