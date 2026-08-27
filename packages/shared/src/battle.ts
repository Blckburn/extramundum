import { z } from 'zod';

/** Зоны рейда. GDD §7.4. */
export const ZONE_IDS = ['wastes', 'warcamp', 'catacombs', 'forge', 'abyss', 'rift'] as const;
export const zoneIdSchema = z.enum(ZONE_IDS);
export type ZoneId = z.infer<typeof zoneIdSchema>;

/** Тиры сложности. GDD §7.3. */
export const DIFFICULTIES = ['normal', 'dangerous', 'nightmare'] as const;
export const difficultySchema = z.enum(DIFFICULTIES);
export type Difficulty = z.infer<typeof difficultySchema>;

/**
 * Хеш текущей экипировки. Клиент присылает его, чтобы сервер мог
 * обнаружить рассинхрон («ты собирался идти вот в этом, а в базе другое»)
 * и чтобы кэшировать превью (GDD §6.4).
 *
 * Это НЕ источник данных о снаряжении: состав экипировки сервер читает
 * из БД (инвариант 1, GDD §3.2 шаг 1). Хеш — только для сверки и кэша.
 */
export const loadoutHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const battleStartInputSchema = z.object({
  zone: zoneIdSchema,
  difficulty: difficultySchema,
  loadoutHash: loadoutHashSchema,
});
export type BattleStartInput = z.infer<typeof battleStartInputSchema>;

/**
 * Гипотетическая правка экипировки для превью. GDD §6.4.
 *
 * Клиент присылает ИДЕНТИФИКАТОР предмета, а не его характеристики.
 * Сервер проверяет владение, собирает набор «как если бы надели»
 * и считает по нему. Подменить силу нечем — схема таких полей
 * не содержит, а предмет читается из БД (инвариант 1).
 */
export const previewChangeSchema = z.union([
  z.object({ kind: z.literal('equip'), itemId: z.uuid() }),
  z.object({ kind: z.literal('unequip'), slot: z.string().min(1) }),
]);
export type PreviewChange = z.infer<typeof previewChangeSchema>;

export const simulatePreviewInputSchema = z.object({
  zone: zoneIdSchema,
  difficulty: difficultySchema,
  loadoutHash: loadoutHashSchema,
  /** Что показать «если надеть». Без него считается текущий набор. */
  change: previewChangeSchema.optional(),
  /**
   * Сколько прогонов Монте-Карло. GDD §6.4 фиксирует 300; параметр
   * ограничен сверху, чтобы запрос не превращался в способ нагрузить сервер.
   */
  runs: z.int().min(50).max(300).default(300),
});
export type SimulatePreviewInput = z.infer<typeof simulatePreviewInputSchema>;

/**
 * Формат боевого лога раскрыт в ./combat.ts вместе с движком (M1a).
 * Здесь остаются только оболочки ответов HTTP.
 */
import type { BattleLog } from './combat.js';

import type { BattleOutcome } from './combat.js';

export type BattleStartResponse = {
  readonly battleId: string;
  readonly log: BattleLog;
  /** Кто победил и с чем остался. Уже вычислено сервером. */
  readonly outcome: BattleOutcome;
  /**
   * Максимум HP каждого бойца.
   *
   * Клиент не может вывести его из лога: `hpAfter` в событии урона — это
   * уже уменьшенное значение, и наибольшее увиденное меньше настоящего
   * максимума ровно на первый удар. Полоса здоровья, построенная
   * на такой догадке, врала бы весь бой.
   *
   * Считать его самостоятельно клиент тем более не вправе: формула
   * `60 + DEF × 6 + уровень × 14 + бонусы` живёт в движке, а движок
   * в браузер не попадает (инвариант 3).
   */
  readonly maxHp: readonly [number, number];
  /**
   * Награды. В M2b ПУСТЫ, и это не забывчивость.
   *
   * GDD §3.2 шаг 5 требует применять HP, XP, золото и лут в одной
   * транзакции — но это прогрессия, то есть M3. Выдать сейчас
   * заглушечные числа значило бы, что через месяц кто-то примет их
   * за настоящие; пустой объект такого не позволяет.
   */
  readonly rewards: Readonly<Record<string, never>>;
  /**
   * Бой проведён до появления прогрессии: наград нет, состояние игрока
   * не менялось. Тем же флагом помечена строка в `battles`.
   *
   * Нужен затем, чтобы в M3 не пришлось выяснять, почему часть боёв
   * без наград — баг это или наследие M2b.
   */
  readonly provisional: boolean;
};

export type SimulatePreviewResponse = {
  /** Оценка шанса победы, 0..1. При `change` — уже С УЧЁТОМ правки. */
  readonly winRate: number;
  /**
   * Шанс победы БЕЗ правки. Присутствует только вместе с `change`.
   *
   * Возвращается вторым числом, а не разницей: разницу клиент покажет
   * сам, а вот проверить её он не сможет, если исходного числа
   * не увидит. «Стало лучше на 4%» без «было 61%» — это не ответ
   * на вопрос §6.4, а его имитация.
   */
  readonly baseWinRate?: number;
  /** Дельты производных статов от правки. Считает сервер. */
  readonly deltas?: Readonly<Record<string, number>>;
  readonly runs: number;
  /**
   * На чём построена оценка.
   *
   * `zone-enemy` — соперники ВЗЯТЫ ИЗ ЗОНЫ: прогоны раскладываются
   * поровну по её обычным монстрам, уровень считается по §7.3 с
   * ограничением диапазоном зоны. Это и есть ответ на вопрос §6.4.
   *
   * `sparring-dummy` — соперник собран масштабированием от уровня игрока,
   * зона на его силу не влияет. Остаётся для зон, которых ещё нет
   * (`rift` отложен до M4). Клиент обязан подписать такое число честно,
   * а не выдавать за оценку по зоне.
   */
  readonly basis: 'sparring-dummy' | 'zone-enemy';
  /**
   * Против кого считалось. Только при `basis: 'zone-enemy'`.
   *
   * Без этого «шанс победы 62%» не проверяем игроком: он не знает,
   * с кем сравнили. Ключи монстров, а не имена, — имена берёт локаль.
   */
  readonly against?: readonly string[];
  /** Уровень противников, посчитанный по §7.3. */
  readonly enemyLevel?: number;
};
