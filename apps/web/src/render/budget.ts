import { RENDER_BUDGETS } from '@extramundum/shared';
import type { Object3D } from 'three';

/**
 * Замер бюджетов производительности. GDD §3.4.
 *
 * Бюджет без автоматической проверки — это комментарий, а не бюджет,
 * поэтому здесь считают, а не описывают.
 */

export type SceneBudget = {
  /** Материалов в сцене. Должно равняться числу РАЗЛИЧНЫХ цветов. */
  readonly materials: number;
  /** Видимых мешей. См. предупреждение ниже про равенство с draw calls. */
  readonly meshes: number;
  /** Геометрий. Коробки разных размеров — разные геометрии. */
  readonly geometries: number;
  /** Треугольников. Прокси нагрузки, FPS отсюда не следует. */
  readonly triangles: number;
  /** Источников света. Каждый удорожает шейдер Lambert. */
  readonly lights: number;
  /**
   * Сколько из мешей — инстансированные. Считаются ОТДЕЛЬНО, потому что
   * один такой меш — это один вызов отрисовки на сколько угодно копий.
   */
  readonly instancedMeshes: number;
  /**
   * Сколько копий в них суммарно.
   *
   * Число вызовов отрисовки от этого не растёт — и ровно поэтому его
   * надо печатать рядом. Иначе «68 вызовов» одинаково читается и когда
   * в кадре 68 коробок, и когда 67 коробок и 220 искр: граница цела,
   * а нагрузка выросла втрое, и замер об этом молчит.
   */
  readonly instances: number;
};

/**
 * ⚠️ ЧТО ИМЕННО ЗНАЧИТ ЗДЕСЬ ЧИСЛО DRAW CALLS ⚠️
 *
 * `meshes` — это ВЕРХНЯЯ ГРАНИЦА числа вызовов отрисовки, а не само
 * число. Живой замер в Chromium даёт 72 при 75 посчитанных: три меша
 * не попали в пирамиду видимости, и рендер их не рисовал. Отсечение
 * работает всегда и всегда в безопасную сторону — реальных вызовов
 * не больше посчитанных.
 *
 * Граница держится, ПОКА выполняются два условия:
 *
 *  1. у меша один материал, а не массив материалов. Меш с массивом
 *     рисуется по группам — один объект, несколько вызовов, и граница
 *     ломается в ОПАСНУЮ сторону;
 *  2. проход рисования один. Карты теней и постобработка — это ещё
 *     по проходу на сцену, то есть кратное число вызовов.
 *
 * Инстансинг границу не ломает: `InstancedMesh` рисуется одним вызовом
 * на много копий, то есть уводит реальное число ВНИЗ. Но и пользы
 * от такой границы становится мало: она перестаёт отражать нагрузку.
 *
 * **ЧТО ИЗМЕНИЛОСЬ В M2b.** Появились партиклы, и с ними первый
 * `InstancedMesh`. Сделано три вещи:
 *
 *  - **на экране показывается живое число.** `renderer.info.render.calls`
 *    после кадра не зависит ни от одного из условий выше. Посчитанное
 *    осталось запасным вариантом — на случай, когда кадра ещё не было;
 *  - **инстансы считаются отдельно** (`instancedMeshes`, `instances`).
 *    Без них «68 вызовов» одинаково выглядит при пустой сцене и при
 *    сцене, забитой искрами: граница цела, нагрузка втрое больше,
 *    а замер об этом молчит;
 *  - **замер идёт ВО ВРЕМЯ БОЯ,** а не на статичной сцене. Замер покоя
 *    доказывает только то, что покой дёшев.
 *
 * Цифры урона — DOM поверх канваса, не меши: в этот замер они не входят
 * и входить не должны (см. numbers.ts, там же — почему DOM).
 */

/**
 * Условия, при которых `meshes` остаётся верхней границей вызовов.
 * Проверяются тестом по исходникам: нарушение любого делает замер
 * недействительным, а не просто неточным.
 */
export const DRAW_CALLS_UPPER_BOUND_HOLDS = true;

export function measureScene(root: Object3D): SceneBudget {
  const materials = new Set<unknown>();
  const geometries = new Set<unknown>();
  let meshes = 0;
  let triangles = 0;
  let lights = 0;
  let instancedMeshes = 0;
  let instances = 0;

  // Обход здесь законен: он выполняется ОДИН раз при замере, а не в кадре.
  // Запрет из GDD §3.4 касается кадрового цикла — см. frame.ts.
  root.traverse((object) => {
    const candidate = object as Object3D & {
      isMesh?: boolean;
      isInstancedMesh?: boolean;
      count?: number;
      isLight?: boolean;
      material?: unknown;
      geometry?: {
        index?: { count: number } | null;
        attributes?: { position?: { count: number } };
      };
    };

    if (candidate.isLight === true) lights += 1;
    if (candidate.isMesh !== true || object.visible !== true) return;

    meshes += 1;
    if (candidate.isInstancedMesh === true) {
      instancedMeshes += 1;
      instances += candidate.count ?? 0;
    }
    if (candidate.material !== undefined) materials.add(candidate.material);

    const geometry = candidate.geometry;
    if (geometry === undefined) return;
    geometries.add(geometry);
    const indexed = geometry.index?.count;
    const positions = geometry.attributes?.position?.count ?? 0;
    triangles += (indexed ?? positions) / 3;
  });

  return {
    materials: materials.size,
    meshes,
    geometries: geometries.size,
    triangles,
    lights,
    instancedMeshes,
    instances,
  };
}

export type BudgetViolation = {
  readonly metric: string;
  readonly actual: number;
  readonly limit: number;
};

/** Нарушенные бюджеты. Пустой список — бюджеты соблюдены. */
export function budgetViolations(budget: SceneBudget): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  if (budget.meshes > RENDER_BUDGETS.drawCalls) {
    violations.push({
      metric: 'draw calls',
      actual: budget.meshes,
      limit: RENDER_BUDGETS.drawCalls,
    });
  }
  return violations;
}
