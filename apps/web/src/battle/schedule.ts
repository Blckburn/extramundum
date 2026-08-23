import type {
  AnimationPrimitive,
  AnimationSpec,
  AnimationStep,
  BattleEvent,
  BattleLog,
} from '@extramundum/shared';

/**
 * Раскладка лога по времени. GDD §3.2, §10.
 *
 * В логе временна́я метка есть только у `turn_start`, и это правильно:
 * движок считает тики, а не миллисекунды. Значит клиент раскладывает
 * события по времени сам — и делает это ОТДЕЛЬНОЙ ЧИСТОЙ ФУНКЦИЕЙ,
 * а не по ходу отрисовки.
 *
 * Зачем так:
 *  - расписание проверяемо без браузера, и детерминизм воспроизведения
 *    («один лог — одна последовательность на экране») становится
 *    утверждением, которое можно уронить тестом;
 *  - скорость ×1/×2/×4 — это множитель времени, а не другое расписание;
 *  - прокрутка назад ищет индекс по времени, а не отматывает анимацию.
 *
 * Клиент здесь ничего не решает: он не знает ни урона, ни шансов,
 * ни исхода. Он знает только, СКОЛЬКО показывать уже случившееся.
 */

export type ScheduledEvent = {
  readonly index: number;
  readonly event: BattleEvent;
  /** Момент начала в миллисекундах от начала боя, при скорости ×1. */
  readonly startMs: number;
  /** Сколько событие занимает в расписании. */
  readonly holdMs: number;
};

export type Schedule = {
  readonly items: readonly ScheduledEvent[];
  readonly totalMs: number;
};

/**
 * Событие без записи в анимациях — ошибка данных, а не повод показать
 * бой без него. Молчаливый ноль означал бы, что удар есть в логе
 * и не существует на экране.
 */
function holdOf(spec: AnimationSpec, event: BattleEvent): number {
  const animation = spec.events[event.t];
  if (animation === undefined) {
    throw new Error(`нет анимации для события «${event.t}» в animations.json`);
  }
  return animation.holdMs;
}

export function schedule(log: BattleLog, spec: AnimationSpec): Schedule {
  const items: ScheduledEvent[] = [];
  let cursor = 0;

  for (let index = 0; index < log.events.length; index++) {
    const event = log.events[index];
    if (event === undefined) continue;
    const holdMs = holdOf(spec, event);
    items.push({ index, event, startMs: cursor, holdMs });
    cursor += holdMs;
  }

  return { items, totalMs: cursor };
}

/**
 * Сколько событий уже показано к моменту `timeMs`.
 *
 * Возвращает КОЛИЧЕСТВО, а не индекс: ноль означает «бой ещё не начался»,
 * и это отличимо от «показано первое событие». Двоичный поиск нужен
 * не ради скорости на сотне событий, а ради того, чтобы функция
 * оставалась чистой и не зависела от предыдущего вызова: перемотка
 * назад обязана давать ровно то же, что перемотка вперёд.
 */
export function shownCount(schedule: Schedule, timeMs: number): number {
  const items = schedule.items;
  let low = 0;
  let high = items.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    const item = items[mid];
    if (item !== undefined && item.startMs + item.holdMs <= timeMs) low = mid + 1;
    else high = mid;
  }

  return low;
}

/** Момент начала события с данным индексом. */
export function timeOfIndex(schedule: Schedule, index: number): number {
  return schedule.items[index]?.startMs ?? schedule.totalMs;
}

/**
 * Момент, когда событие ЗАКОНЧИЛОСЬ. Сюда ведёт клик по строке журнала.
 *
 * Не в начало события — и это исправление, а не вкус. Показанным
 * считается то, что УЖЕ случилось (см. `shownCount`), поэтому перемотка
 * в начало события делала его непоказанным: строка, по которой только
 * что кликнули, пряталась вместе с раскрытым разбором броска. Ровно тот
 * случай, когда «показать мне этот момент» и «этот момент ещё
 * не наступил» — одно и то же число.
 */
export function endOfIndex(schedule: Schedule, index: number): number {
  const item = schedule.items[index];
  return item === undefined ? schedule.totalMs : item.startMs + item.holdMs;
}

/**
 * Один примитив, привязанный к абсолютному моменту.
 *
 * Зачем плоский список вместо «сработало событие — проиграй его шаги»:
 * у шага есть собственная задержка, и при событийном запуске её пришлось
 * бы держать отдельным таймером на каждый шаг. Тогда пауза, перемотка
 * и скорость ×4 стали бы тремя разными видами бухгалтерии вместо одного
 * сравнения с часами.
 *
 * Плоский список ещё и делает воспроизведение проверяемым без браузера:
 * «этот лог даёт вот такую последовательность примитивов в такие
 * моменты» — утверждение, которое можно уронить тестом.
 */
export type TimedStep = {
  readonly atMs: number;
  /** Индекс события в логе: по нему берётся актор и цель. */
  readonly index: number;
  readonly event: BattleEvent;
  readonly step: AnimationStep;
};

export function timeline(plan: Schedule, spec: AnimationSpec): readonly TimedStep[] {
  const steps: TimedStep[] = [];

  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i];
    if (item === undefined) continue;
    const animation = spec.events[item.event.t];
    if (animation === undefined) continue;
    for (let s = 0; s < animation.steps.length; s++) {
      const step = animation.steps[s];
      if (step === undefined) continue;
      steps.push({
        atMs: item.startMs + step.delayMs,
        index: item.index,
        event: item.event,
        step,
      });
    }
  }

  // Устойчивая сортировка по времени: шаг с задержкой может обогнать
  // начало следующего события, и это нормально — бой не должен
  // распадаться на отдельные позы.
  steps.sort((a, b) => (a.atMs === b.atMs ? a.index - b.index : a.atMs - b.atMs));
  return steps;
}

/**
 * Примитивы, которые НЕ возвращаются к покою.
 *
 * Набор, а не флаг в данных: «остаётся ли след» — свойство самого
 * примитива, а не настройка конкретной анимации. Позволить данным это
 * переключать значило бы разрешить падение, после которого боец встаёт.
 */
export const PERSISTENT_PRIMITIVES = new Set<AnimationPrimitive>(['topple']);

/**
 * Стойкие шаги, уже случившиеся к моменту `timeMs`.
 *
 * Перемотка гасит всё преходящее — искры и числа от событий, которых
 * в новом моменте нет. Но упавший боец не эффект, который доиграл,
 * а положение, в котором он находится: после перемотки в конец он
 * обязан лежать, даже если анимацию падения никто не смотрел. Обратное
 * было видно на экране — «Сразу итог» оставлял труп стоять.
 *
 * Возвращаются шаги С ИХ НАСТОЯЩИМИ моментами, а не «уже случилось»:
 * перемотка в середину падения обязана давать середину падения.
 */
export function persistentStepsBefore(
  steps: readonly TimedStep[],
  timeMs: number,
): readonly TimedStep[] {
  const upTo = stepCursorAt(steps, timeMs);
  const result: TimedStep[] = [];
  for (let i = 0; i < upTo; i++) {
    const timed = steps[i];
    if (timed !== undefined && PERSISTENT_PRIMITIVES.has(timed.step.primitive)) result.push(timed);
  }
  return result;
}

/** Первый шаг, который ещё НЕ сыгран к моменту `timeMs`. Для перемотки. */
export function stepCursorAt(steps: readonly TimedStep[], timeMs: number): number {
  let low = 0;
  let high = steps.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const item = steps[mid];
    if (item !== undefined && item.atMs <= timeMs) low = mid + 1;
    else high = mid;
  }
  return low;
}
