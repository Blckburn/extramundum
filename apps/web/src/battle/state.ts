import type { BattleEvent, BattleLog, StatusId, TraitId } from '@extramundum/shared';

/**
 * Состояние боя на момент N-го события. GDD §3.2.
 *
 * СВЁРТКА ПРЕФИКСА ЛОГА, а не накопление мутациями. Разница решающая:
 * при свёртке прокрутка назад точна, потому что состояние вычисляется
 * заново из начала; при накоплении её пришлось бы «отматывать», и любой
 * эффект, отменённый неточно, копил бы ошибку до конца боя.
 *
 * Это ровно тот класс поломки, из-за которого в v1.0 обнулялись HP
 * от путей (GDD §13, пункт 2), только в другом месте.
 *
 * Стоимость — линейный проход на каждую перемотку. Событий в бою
 * несколько сотен, и это дешевле одной отрисовки кадра.
 */

export type ActiveStatus = {
  /** Номер экземпляра из лога. Два кровотечения — два разных номера. */
  readonly instance: number;
  readonly status: StatusId;
  readonly stacks: number;
  /** Длительность в тиках на момент наложения. −1 — до конца боя. */
  readonly duration: number;
  /** Индекс события, которым статус наложен. */
  readonly appliedAt: number;
  /**
   * Тик боя, на котором статус наложен.
   *
   * Нужен, чтобы показать ОСТАТОК длительности на иконке. Остаток
   * выводится вычитанием, а не приходит из лога: событие `status_tick`
   * величины остатка не несёт, а расширять формат лога ради подписи
   * под иконкой — это менять контракт с движком ради оформления.
   * Величина показательная, и в журнале она ни на что не влияет.
   */
  readonly appliedTick: number;
};

export type FighterState = {
  readonly hp: number;
  readonly alive: boolean;
  readonly statuses: readonly ActiveStatus[];
  /** Последний сработавший трейт — для подписи под бойцом. */
  readonly lastTrait: TraitId | null;
};

export type BattleState = {
  readonly fighters: readonly [FighterState, FighterState];
  /** Чей сейчас ход, если последним событием был `turn_start`. */
  readonly acting: 0 | 1 | null;
  readonly tick: number;
  readonly winner: 0 | 1 | null;
};

/**
 * Максимум HP в состояние НЕ входит: его присылает сервер отдельно.
 *
 * Вывести его из лога нельзя — `hpAfter` уже уменьшен на удар, — а считать
 * самостоятельно клиент не вправе: формула живёт в движке, а движок
 * в браузер не попадает (инвариант 3).
 */
function emptyFighter(): FighterState {
  return { hp: 1, alive: true, statuses: [], lastTrait: null };
}

export function initialState(): BattleState {
  return { fighters: [emptyFighter(), emptyFighter()], acting: null, tick: 0, winner: null };
}

/**
 * Свернуть первые `count` событий лога в состояние.
 *
 * `startHp` — максимум HP от сервера. По умолчанию единица, потому что
 * ВЫДУМЫВАТЬ его нельзя: наибольшее `hpAfter` в логе меньше настоящего
 * максимума ровно на первый удар, и полоса здоровья, построенная на такой
 * догадке, врала бы весь бой.
 */
export function stateAt(
  log: BattleLog,
  count: number,
  startHp: readonly [number, number] = [1, 1],
): BattleState {
  const hp: [number, number] = [startHp[0] ?? 1, startHp[1] ?? 1];
  const alive: [boolean, boolean] = [true, true];
  const statuses: [ActiveStatus[], ActiveStatus[]] = [[], []];
  const lastTrait: [TraitId | null, TraitId | null] = [null, null];
  let acting: 0 | 1 | null = null;
  let tick = 0;
  let winner: 0 | 1 | null = null;

  const limit = Math.min(count, log.events.length);
  for (let i = 0; i < limit; i++) {
    const event = log.events[i];
    if (event === undefined) continue;
    // Тик обновляется до применения события.
    //
    // На результат перестановка этих двух строк сейчас не влияет,
    // и это проверено диверсией: `status_apply` приходит хуками ПОСЛЕ
    // события `turn_start`, то есть отдельной итерацией цикла, и обе
    // расстановки дают одно и то же. Порядок выбран такой, потому что
    // читается однозначно: «тик боя наступил, дальше идут его события».
    if (event.t === 'turn_start') tick = event.tick;
    apply(event, i, tick, hp, alive, statuses, lastTrait, (a) => (acting = a));

    if (event.t === 'death') winner = event.actor === 0 ? 1 : 0;
  }

  return {
    fighters: [
      { hp: hp[0], alive: alive[0], statuses: statuses[0], lastTrait: lastTrait[0] },
      { hp: hp[1], alive: alive[1], statuses: statuses[1], lastTrait: lastTrait[1] },
    ],
    acting,
    tick,
    winner,
  };
}

function apply(
  event: BattleEvent,
  index: number,
  tick: number,
  hp: [number, number],
  alive: [boolean, boolean],
  statuses: [ActiveStatus[], ActiveStatus[]],
  lastTrait: [TraitId | null, TraitId | null],
  setActing: (actor: 0 | 1) => void,
): void {
  switch (event.t) {
    case 'turn_start': {
      setActing(event.actor);
      return;
    }
    case 'damage': {
      hp[event.target] = event.hpAfter;
      return;
    }
    case 'status_apply': {
      const list = statuses[event.target];
      const existing = list.findIndex((s) => s.instance === event.instance);
      const entry: ActiveStatus = {
        instance: event.instance,
        status: event.status,
        stacks: event.stacks,
        duration: event.duration,
        appliedAt: index,
        appliedTick: tick,
      };
      if (existing >= 0) list[existing] = entry;
      else list.push(entry);
      return;
    }
    case 'status_expire': {
      const list = statuses[event.target];
      const at = list.findIndex((s) => s.instance === event.instance);
      if (at >= 0) list.splice(at, 1);
      return;
    }
    case 'status_tick': {
      const list = statuses[event.target];
      const at = list.findIndex((s) => s.instance === event.instance);
      const current = list[at];
      if (at >= 0 && current !== undefined) {
        list[at] = { ...current, stacks: event.stacks };
      }
      return;
    }
    case 'trait_fire': {
      lastTrait[event.actor] = event.trait;
      return;
    }
    case 'death': {
      alive[event.actor] = false;
      hp[event.actor] = 0;
      return;
    }
    default:
      return;
  }
}
