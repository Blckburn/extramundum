import { describe, expect, it } from 'vitest';

import { stateAt } from '../state.ts';

import { fixture, log } from './fixture.ts';

/**
 * Свёртка префикса лога. GDD §3.2.
 *
 * Главное свойство — ТОЧНОСТЬ ПЕРЕМОТКИ НАЗАД. Накопительная модель
 * даёт его только при безошибочной отмене каждого эффекта, а одна
 * неточная отмена копится до конца боя. Ровно этот класс поломки —
 * пункт 2 аудита v1.0.
 */

const MAX_HP: readonly [number, number] = [200, 200];
const last = log.events.length;

describe('состояние на момент события', () => {
  it('в выборке есть статусы, и их больше одного одновременно', () => {
    // Всё, что ниже проверяет поведение статусов, бессмысленно на логе,
    // где статус не наложился ни разу. Требуем сразу двух одновременных:
    // иначе «истёк нужный экземпляр, остальные на месте» проходило бы
    // при отсутствии «остальных».
    let maxSimultaneous = 0;
    for (let i = 0; i <= last; i++) {
      const state = stateAt(log, i, MAX_HP);
      maxSimultaneous = Math.max(
        maxSimultaneous,
        state.fighters[0].statuses.length + state.fighters[1].statuses.length,
      );
    }
    expect(maxSimultaneous).toBeGreaterThanOrEqual(2);
  });

  it('свёртка не зависит от порядка обращений', () => {
    // Перемотка назад пересчитывает с начала — значит результат обязан
    // совпадать с тем, что получилось бы при движении вперёд.
    const forward: string[] = [];
    for (let i = 0; i <= last; i += 7) forward.push(JSON.stringify(stateAt(log, i, MAX_HP)));

    const backward: string[] = [];
    for (let i = Math.floor(last / 7) * 7; i >= 0; i -= 7) {
      backward.unshift(JSON.stringify(stateAt(log, i, MAX_HP)));
    }

    expect(backward).toEqual(forward);
    // Выборка должна РАЗЛИЧАТЬСЯ, иначе сравнивались бы копии одного.
    expect(new Set(forward).size).toBeGreaterThan(10);
  });

  it('здоровье в конце совпадает с исходом от движка', () => {
    // Самая сильная проверка свёртки: клиент не считает урон, он
    // складывает hpAfter из лога — и обязан прийти ровно туда же,
    // куда пришёл движок.
    const final = stateAt(log, last, MAX_HP);
    const winner = fixture.outcome.winner;
    expect(winner).not.toBeNull();
    if (winner === null) return;

    expect(final.winner).toBe(winner);
    expect(final.fighters[winner].hp).toBe(fixture.outcome.hpRemaining[winner]);
    expect(final.fighters[winner === 0 ? 1 : 0].alive).toBe(false);
  });

  it('здоровье начинается с максимума, присланного сервером', () => {
    const start = stateAt(log, 0, MAX_HP);
    expect(start.fighters[0].hp).toBe(MAX_HP[0]);
    expect(start.fighters[1].hp).toBe(MAX_HP[1]);
  });

  it('экземпляры статусов различаются номером, а не идентификатором', () => {
    // Кровотечение и яд стакаются независимыми экземплярами (GDD §4.4).
    // Если рендер сольёт их по идентификатору, игрок увидит один таймер
    // вместо двух и не поймёт, почему умирает вдвое быстрее.
    const seen = new Map<number, string>();
    let sameIdDifferentInstances = 0;

    for (let i = 0; i <= last; i++) {
      for (const fighter of stateAt(log, i, MAX_HP).fighters) {
        const byId = new Map<string, Set<number>>();
        for (const status of fighter.statuses) {
          seen.set(status.instance, status.status);
          const set = byId.get(status.status) ?? new Set<number>();
          set.add(status.instance);
          byId.set(status.status, set);
        }
        for (const set of byId.values()) {
          if (set.size > 1) sameIdDifferentInstances++;
        }
      }
    }

    expect(seen.size).toBeGreaterThan(1);
    // Номер экземпляра уникален в пределах боя: два разных экземпляра
    // не могут оказаться одним и тем же номером.
    expect(new Set(seen.keys()).size).toBe(seen.size);
    expect(sameIdDifferentInstances).toBeGreaterThan(0);
  });

  it('истечение убирает ровно свой экземпляр', () => {
    const expiries = log.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.t === 'status_expire');
    expect(expiries.length).toBeGreaterThan(0);

    for (const { event, index } of expiries) {
      if (event.t !== 'status_expire') continue;
      const before = stateAt(log, index, MAX_HP).fighters[event.target].statuses;
      const after = stateAt(log, index + 1, MAX_HP).fighters[event.target].statuses;

      expect(before.map((s) => s.instance)).toContain(event.instance);
      expect(after.map((s) => s.instance)).not.toContain(event.instance);
      // Остальные на месте: разница ровно в один экземпляр.
      expect(after.length).toBe(before.length - 1);
    }
  });

  it('остаток длительности отсчитывается от тика наложения', () => {
    const applies = log.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.t === 'status_apply');
    expect(applies.length).toBeGreaterThan(0);

    for (const { event, index } of applies) {
      if (event.t !== 'status_apply') continue;
      const state = stateAt(log, index + 1, MAX_HP);
      const entry = state.fighters[event.target].statuses.find(
        (s) => s.instance === event.instance,
      );
      expect(entry).toBeDefined();

      // Ожидаемый тик берётся ИЗ ЛОГА, а не из того же состояния.
      //
      // Первая версия сравнивала `appliedTick` с `state.tick` — и это
      // ничего не проверяло: обе величины считает один и тот же проход,
      // и перестановка строк местами оставляла их согласованными.
      // Диверсия «обновлять тик ПОСЛЕ применения события» прошла мимо.
      let expected = 0;
      for (let i = index; i >= 0; i--) {
        const prior = log.events[i];
        if (prior?.t === 'turn_start') {
          expected = prior.tick;
          break;
        }
      }
      expect(entry?.appliedTick).toBe(expected);
    }

    // И среди наложений обязаны быть сделанные НЕ на нулевом тике,
    // иначе сравнение сошлось бы на нулях.
    const ticks = new Set(
      applies.map(({ index }) => {
        for (let i = index; i >= 0; i--) {
          const prior = log.events[i];
          if (prior?.t === 'turn_start') return prior.tick;
        }
        return 0;
      }),
    );
    expect(ticks.size).toBeGreaterThan(1);
  });
});
