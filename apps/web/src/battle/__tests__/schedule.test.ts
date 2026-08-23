import { animations } from '@extramundum/data';
import type { AnimationSpec } from '@extramundum/shared';
import { describe, expect, it } from 'vitest';

import {
  endOfIndex,
  persistentStepsBefore,
  schedule,
  shownCount,
  stepCursorAt,
  timeline,
  timeOfIndex,
} from '../schedule.ts';

import { log } from './fixture.ts';

/**
 * Раскладка лога по времени. GDD §3.2, §10.
 *
 * Расписание — чистая функция, и именно поэтому проверяемо без браузера.
 * Утверждение «один лог даёт одну последовательность на экране» здесь
 * можно уронить тестом, а не принять на веру.
 */

const plan = schedule(log, animations);
const steps = timeline(plan, animations);

describe('расписание', () => {
  it('в выборке есть все типы событий — иначе проверять нечего', () => {
    // Тесты ниже вида «ни одно событие не роняет раскладку» проходят
    // и на логе из одних ударов. Без этой проверки они не доказывают
    // ничего: тип, которого нет в выборке, никто не проверял.
    const kinds = new Set(log.events.map((event) => event.t));
    expect(kinds.size).toBe(Object.keys(animations.events).length);
    expect(log.events.length).toBeGreaterThan(100);
  });

  it('каждому событию лога соответствует ровно одна запись', () => {
    expect(plan.items).toHaveLength(log.events.length);
    for (let i = 0; i < plan.items.length; i++) {
      expect(plan.items[i]?.index).toBe(i);
      expect(plan.items[i]?.event).toBe(log.events[i]);
    }
  });

  it('записи идут подряд и без разрывов, а сумма даёт длину боя', () => {
    let cursor = 0;
    for (const item of plan.items) {
      expect(item.startMs).toBe(cursor);
      expect(item.holdMs).toBeGreaterThan(0);
      cursor += item.holdMs;
    }
    expect(plan.totalMs).toBe(cursor);
  });

  it('событие без анимации роняет раскладку, а не показывается молча', () => {
    // Диверсия: убрать удар из animations.json. Молчаливый ноль означал
    // бы, что удар есть в логе и не существует на экране.
    const crippled = {
      ...animations,
      events: Object.fromEntries(
        Object.entries(animations.events).filter(([kind]) => kind !== 'attack'),
      ),
    } as AnimationSpec;

    expect(() => schedule(log, crippled)).toThrow(/attack/);
  });
});

describe('сколько показано к моменту времени', () => {
  it('на границах события — ровно столько, сколько закончилось', () => {
    const first = plan.items[0];
    const second = plan.items[1];
    if (first === undefined || second === undefined) throw new Error('лог слишком короток');

    expect(shownCount(plan, 0)).toBe(0);
    expect(shownCount(plan, first.holdMs - 1)).toBe(0);
    expect(shownCount(plan, first.holdMs)).toBe(1);
    expect(shownCount(plan, first.holdMs + second.holdMs)).toBe(2);
    expect(shownCount(plan, plan.totalMs)).toBe(plan.items.length);
  });

  it('не зависит от того, идём мы вперёд или назад', () => {
    // Свойство, ради которого функция чистая: перемотка назад обязана
    // давать ровно то же, что перемотка вперёд. Накопительный счётчик
    // этого не даёт, и расхождение накапливалось бы до конца боя.
    const times: number[] = [];
    for (let t = 0; t <= plan.totalMs; t += 37) times.push(t);
    times.push(plan.totalMs);

    const forward = times.map((t) => shownCount(plan, t));
    const backward = [...times].reverse().map((t) => shownCount(plan, t));
    expect(backward.reverse()).toEqual(forward);

    // И оно монотонно: показанное не убывает со временем.
    for (let i = 1; i < forward.length; i++) {
      expect(forward[i]).toBeGreaterThanOrEqual(forward[i - 1] ?? 0);
    }
    // Проверка, что выборка вообще что-то поймала: иначе равенство
    // двух пустых списков прошло бы точно так же.
    expect(forward.at(-1)).toBe(plan.items.length);
    expect(new Set(forward).size).toBeGreaterThan(10);
  });

  it('начало события — это момент, когда оно ЕЩЁ НЕ показано', () => {
    for (const index of [0, 5, 40, log.events.length - 1]) {
      expect(shownCount(plan, timeOfIndex(plan, index))).toBe(index);
    }
  });

  it('перемотка по строке журнала ПОКАЗЫВАЕТ её событие', () => {
    // Иначе строка, по которой кликнули, пряталась вместе с раскрытым
    // разбором броска: перемотка в начало события делает его
    // непоказанным. Поймано глазами на живом экране.
    for (const index of [0, 5, 40, log.events.length - 1]) {
      expect(shownCount(plan, endOfIndex(plan, index))).toBe(index + 1);
    }
  });
});

describe('плоский список примитивов', () => {
  it('содержит все шаги всех событий', () => {
    let expected = 0;
    for (const event of log.events) expected += animations.events[event.t]?.steps.length ?? 0;
    expect(steps).toHaveLength(expected);
    expect(steps.length).toBeGreaterThan(log.events.length);
  });

  it('отсортирован по времени', () => {
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]?.atMs).toBeGreaterThanOrEqual(steps[i - 1]?.atMs ?? 0);
    }
  });

  it('курсор по времени совпадает с прямым перебором', () => {
    // Двоичный поиск существует ради чистоты, а не ради скорости —
    // значит обязан совпадать с наивным перебором всюду, включая
    // границы, где события начинаются в один и тот же момент.
    for (let t = 0; t <= plan.totalMs; t += 53) {
      const naive = steps.filter((step) => step.atMs <= t).length;
      expect(stepCursorAt(steps, t)).toBe(naive);
    }
  });

  it('шаг с задержкой стоит позже начала своего события', () => {
    // Задержка — единственная причина, по которой список нужно
    // сортировать. Если её нигде нет, сортировка не проверена.
    const delayed = steps.filter((step) => step.step.delayMs > 0);
    expect(delayed.length).toBeGreaterThan(0);
    for (const step of delayed) {
      const own = plan.items[step.index];
      expect(step.atMs).toBe((own?.startMs ?? 0) + step.step.delayMs);
    }
  });
});

describe('стойкое переживает перемотку, преходящее — нет', () => {
  const deathIndex = log.events.findIndex((event) => event.t === 'death');

  it('в выборке есть смерть, и у неё есть стойкий шаг', () => {
    // Иначе проверки ниже сравнивали бы пустые списки: «после перемотки
    // ничего не восстановилось» верно и когда восстанавливать нечего.
    expect(deathIndex).toBeGreaterThan(0);
    expect(animations.events['death']?.steps.some((step) => step.primitive === 'topple')).toBe(
      true,
    );
  });

  it('после конца боя упавший восстанавливается, до смерти — нет', () => {
    const beforeDeath = persistentStepsBefore(steps, timeOfIndex(plan, deathIndex));
    const afterAll = persistentStepsBefore(steps, plan.totalMs);

    expect(beforeDeath).toHaveLength(0);
    expect(afterAll).toHaveLength(1);
    expect(afterAll[0]?.event.t).toBe('death');
    expect(afterAll[0]?.step.primitive).toBe('topple');
  });

  it('восстановленный шаг несёт СВОЙ момент, а не «уже случилось»', () => {
    // Перемотка в середину падения обязана давать середину падения.
    const [restored] = persistentStepsBefore(steps, plan.totalMs);
    expect(restored).toBeDefined();
    expect(restored?.atMs).toBe(
      timeOfIndex(plan, deathIndex) +
        (animations.events['death']?.steps.find((step) => step.primitive === 'topple')?.delayMs ??
          -1),
    );
  });

  it('преходящие шаги не восстанавливаются', () => {
    const all = persistentStepsBefore(steps, plan.totalMs);
    const transient = steps.filter((step) => step.step.primitive !== 'topple');
    expect(transient.length).toBeGreaterThan(100);
    for (const step of all) expect(step.step.primitive).toBe('topple');
  });
});
