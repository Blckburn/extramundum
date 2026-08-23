import type {
  ActorIndex,
  BattleEvent,
  BattleLog,
  RollBreakdown,
  StatusId,
} from '@extramundum/shared';

/**
 * Модель журнала боя. GDD §3.2, §10.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ЧИСТАЯ ФУНКЦИЯ, А НЕ РАЗМЕТКА ПО ХОДУ. Журнал
 * существует затем, чтобы игрок понял, ПОЧЕМУ проиграл: вмешаться
 * в бой он не может, значит единственное, что у него есть, — разбор
 * после. Разбор, собранный вперемешку с DOM, нельзя ни проверить,
 * ни доказать. Собранный отдельно — можно: «вот лог, вот строки».
 *
 * ГЛАВНОЕ РЕШЕНИЕ ЗДЕСЬ — СВЁРТКА ТИКОВ. Сотня строк «яд снял 4»
 * топит удары, криты и срабатывания трейтов: сигнал тонет, и журнал
 * перестаёт работать, будучи формально реализованным. Поэтому подряд
 * идущие тики статусов сворачиваются в ОДНУ строку с суммой,
 * а разворачиваются по клику.
 *
 * Свёртка идёт по ПОДРЯД ИДУЩИМ тикам, а не «по ходу»: так строка
 * стоит ровно там, где тики случились, и порядок журнала совпадает
 * с порядком лога. Тики приходят пачкой в конце тика боя (GDD §4.1),
 * поэтому на практике это и есть «по ходу», но без допущения.
 */

export type EffectEntry = {
  readonly index: number;
  readonly target: ActorIndex;
  readonly status: StatusId;
  readonly stacks: number;
  /** Сколько эффект дал в этот тик. У части статусов величины нет. */
  readonly amount: number | null;
};

export type JournalEntry =
  | {
      readonly kind: 'turn';
      readonly index: number;
      readonly tick: number;
      readonly actor: ActorIndex;
    }
  | {
      readonly kind: 'strike';
      readonly index: number;
      readonly actor: ActorIndex;
      readonly target: ActorIndex;
      readonly roll: RollBreakdown;
      /** Доля, снятая блоком, либо null — блока не было. */
      readonly blocked: number | null;
      /** Урон по цели. null — удар не дошёл (например, поглощён щитом). */
      readonly damage: number | null;
      readonly crit: boolean;
      readonly hpAfter: number | null;
    }
  | { readonly kind: 'dodge'; readonly index: number; readonly actor: ActorIndex }
  | {
      readonly kind: 'effects';
      readonly index: number;
      readonly entries: readonly EffectEntry[];
      /** Сумма величин. Ноль означает «тики были, величин у них нет». */
      readonly total: number;
    }
  | { readonly kind: 'event'; readonly index: number; readonly event: BattleEvent };

/**
 * Урон удара ищется ВПЕРЁД до конца хода, а не «следующим событием».
 *
 * Между `attack` и `damage` встают события поглощения щитом: щит съедает
 * часть удара и расходуется, и это отдельные записи лога. Правило
 * «следующее событие — урон» сломалось бы на первом же щите, причём
 * молча: журнал показал бы удар без числа.
 *
 * Цель обязана быть ЧУЖОЙ: `thorns` и `retribution` тоже пишут `damage`,
 * но по атакующему, и это не урон его удара.
 */
function findStrikeDamage(
  events: readonly BattleEvent[],
  from: number,
  attacker: ActorIndex,
): { amount: number; crit: boolean; hpAfter: number } | null {
  for (let i = from + 1; i < events.length; i++) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.t === 'turn_start' || event.t === 'attack' || event.t === 'dodge') return null;
    if (event.t === 'damage' && event.target !== attacker) {
      return { amount: event.amount, crit: event.crit, hpAfter: event.hpAfter };
    }
  }
  return null;
}

/** Блок ищется в тех же границах и по тому же основанию. */
function findBlock(
  events: readonly BattleEvent[],
  from: number,
  attacker: ActorIndex,
): number | null {
  for (let i = from + 1; i < events.length; i++) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.t === 'turn_start' || event.t === 'attack' || event.t === 'damage') return null;
    if (event.t === 'block' && event.actor !== attacker) return event.mitigated;
  }
  return null;
}

export function buildJournal(log: BattleLog): readonly JournalEntry[] {
  const rows: JournalEntry[] = [];
  const events = log.events;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event === undefined) continue;

    switch (event.t) {
      case 'turn_start':
        rows.push({ kind: 'turn', index: i, tick: event.tick, actor: event.actor });
        break;

      case 'attack': {
        const damage = findStrikeDamage(events, i, event.actor);
        rows.push({
          kind: 'strike',
          index: i,
          actor: event.actor,
          target: event.actor === 0 ? 1 : 0,
          roll: event.roll,
          blocked: findBlock(events, i, event.actor),
          damage: damage?.amount ?? null,
          crit: damage?.crit ?? false,
          hpAfter: damage?.hpAfter ?? null,
        });
        break;
      }

      case 'dodge':
        rows.push({ kind: 'dodge', index: i, actor: event.actor });
        break;

      case 'status_tick': {
        // Собрать всю подряд идущую пачку тиков в одну строку.
        const entries: EffectEntry[] = [];
        let total = 0;
        let j = i;
        for (; j < events.length; j++) {
          const tick = events[j];
          if (tick === undefined || tick.t !== 'status_tick') break;
          const amount = tick.amount ?? null;
          if (amount !== null) total += amount;
          entries.push({
            index: j,
            target: tick.target,
            status: tick.status,
            stacks: tick.stacks,
            amount,
          });
        }
        rows.push({ kind: 'effects', index: i, entries, total });
        i = j - 1;
        break;
      }

      case 'block':
      case 'damage':
        // Блок уже показан в строке удара. Урон — тоже, КРОМЕ урона
        // по атакующему: шипы и возмездие бьют в обратную сторону,
        // и это отдельное событие, которое игрок обязан увидеть.
        if (event.t === 'damage' && isReflected(events, i)) {
          rows.push({ kind: 'event', index: i, event });
        }
        break;

      default:
        rows.push({ kind: 'event', index: i, event });
        break;
    }
  }

  return rows;
}

/**
 * Урон, который НЕ принадлежит удару текущего хода.
 *
 * Он определяется тем же основанием, что и поиск вперёд: урон удара
 * идёт по цели атакующего. Урон по САМОМУ атакующему приходит от шипов
 * или возмездия — его строка обязана быть своей, иначе игрок увидит
 * потерю HP без причины.
 */
function isReflected(events: readonly BattleEvent[], at: number): boolean {
  const event = events[at];
  if (event === undefined || event.t !== 'damage') return false;

  for (let i = at - 1; i >= 0; i--) {
    const prior = events[i];
    if (prior === undefined) continue;
    if (prior.t === 'turn_start') return prior.actor === event.target;
    if (prior.t === 'attack') return prior.actor === event.target;
  }
  return false;
}
