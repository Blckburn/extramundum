/**
 * @extramundum/sim — детерминированные системы, считающие от сида:
 * бой и генерация лута.
 *
 * ЭТАП M1a: ядро. Генератор, цикл по тикам, пайплайн урона, матчапы,
 * формат лога. Статусы (M1b) и трейты (M1c) объявлены интерфейсами
 * с пустыми реестрами — по правилу GDD §4.5.
 *
 * Правила этого пакета, действующие с первого коммита:
 *
 *  1. Ноль РАНТАЙМ-зависимостей. Типы контракта приходят из
 *     @extramundum/shared через `import type` — такой импорт стирается
 *     при компиляции, в dist не остаётся ни одного `import` наружу.
 *     Причина и подпорки — docs/adr/0003-tipy-kontrakta-v-shared.md.
 *     Проверяется тестом по собранному dist, а не по манифесту.
 *  2. Ноль I/O. Ни сети, ни файловой системы, ни БД.
 *  3. Никакого `Math.random()` и `Date.now()`. Источник случайности —
 *     только сид, переданный аргументом. Один сид -> побитово
 *     идентичный результат. Проверяется тестом.
 *  4. Пакет не попадает в браузерный бандл (GDD §3.1). Импорт из
 *     apps/web запрещён правилом ESLint, отсутствие в собранном
 *     бандле проверяется scripts/check-bundle.mjs.
 */

/**
 * Уникальная строка-маркер. Единственное её назначение — дать
 * scripts/check-bundle.mjs что искать в собранном клиентском бандле.
 * Если маркер найден в dist клиента, значит движок туда просочился,
 * и сборка обязана упасть.
 */
export const SIM_BUNDLE_MARKER = 'EXTRAMUNDUM_SIM_MUST_NEVER_REACH_THE_BROWSER';

/**
 * Версия формата боевого лога. Одно определение — в resolve.ts, рядом
 * с кодом, который лог собирает. Два независимых счётчика версий
 * разошлись бы на первом же изменении формата.
 */
export { LOG_VERSION as SIM_LOG_VERSION } from './resolve.js';

export { rngFromSeed, rngFromState, seedToState, type Rng, type RngState } from './rng.js';
export {
  atkMultiplier,
  createFighterState,
  effectiveStats,
  critChance,
  dodgeChance,
  ilvlScale,
  matchupMultiplier,
  maxHp,
  familyMultiplier,
  mitigation,
  type EffectiveStats,
  type FighterState,
} from './fighter.js';
export { resolveAttack, type AttackOutcome } from './damage.js';
export { resolveBattle, LOG_VERSION } from './resolve.js';
export {
  applyStatus,
  absorbDamage,
  actionPrevented,
  compareInstances,
  createStatusClock,
  orderedStatuses,
  statusDefinition,
  tickFighterStatuses,
  STATUS_ORDER,
  STATUS_REGISTRY,
  type StatModifiers,
  type StatusCategory,
  type StatusClock,
  type StatusDefinition,
  type StatusInstance,
  type TickResult,
} from './statuses.js';
export { TRAITS, type Trait, type TraitContext, type TraitHooks } from './traits.js';
export { allowedTiers, generateItem, type GeneratedItem, type GenerateItemInput } from './loot.js';
