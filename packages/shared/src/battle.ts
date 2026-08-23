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

export const simulatePreviewInputSchema = z.object({
  zone: zoneIdSchema,
  difficulty: difficultySchema,
  loadoutHash: loadoutHashSchema,
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
  /** Оценка шанса победы, 0..1. */
  readonly winRate: number;
  readonly runs: number;
  /**
   * На чём построена оценка.
   *
   * `sparring-dummy` — соперник собран масштабированием от уровня игрока
   * со сдвигом по сложности, зона на его силу не влияет: настоящие
   * противники зон появятся в M3. Клиент обязан подписать такое число
   * честно, а не выдавать за оценку по зоне.
   *
   * `zone-enemy` появится вместе с генерацией врагов.
   */
  readonly basis: 'sparring-dummy' | 'zone-enemy';
};
