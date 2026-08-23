import type { ActorIndex, BattleLog, RollBreakdown, StatusId, TraitId } from '@extramundum/shared';

import { buildJournal, type EffectEntry, type JournalEntry } from '../battle/journal.ts';
import { el } from '../dom.ts';
import { t } from '../i18n.ts';

/**
 * Журнал боя. GDD §3.2, §10.
 *
 * Журнал существует затем, чтобы игрок понял, ПОЧЕМУ проиграл: в бой
 * он не вмешивается, значит разбор после боя — единственное, что у него
 * есть. Отсюда два решения, которые здесь важнее любой вёрстки:
 *
 *  1. **Тики свёрнуты.** Сотня строк «яд снял 4» топит удары, криты
 *     и срабатывания трейтов. Свёрнутая строка с суммой разворачивается
 *     по клику — величины не потеряны, но не заслоняют главное.
 *  2. **Разбор броска перемножается на глазах.** Показать «урон 15» —
 *     значит не объяснить ничего. Показаны ВСЕ множители и их
 *     произведение, и произведение обязано совпасть с уроном из лога.
 *     Не совпало — строка об этом скажет, а не подгонит.
 *
 * Число `final` берётся ИЗ ЛОГА, а произведение считается здесь только
 * для показа. Это не расчёт боя: клиент проверяет сервер, а не заменяет
 * его. Если однажды они разойдутся, игрок увидит расхождение, а не
 * красивую цифру.
 */

export type JournalView = {
  readonly element: HTMLElement;
  /**
   * Показать первые `shown` событий. Остальные ещё не случились.
   *
   * `follow` — прокручивать ли к последней раскрытой строке. Пока бой
   * идёт, это нужно: иначе журнал «работает», а игрок смотрит на начало
   * боя, пока идёт конец. Но на паузе прокрутка вредна и была багом:
   * клик по строке ставит бой на паузу и перематывает, перемотка меняет
   * показанное, показанное дёргало прокрутку — и разбор броска уезжал
   * из виду ровно в тот момент, когда его открыли.
   */
  reveal(shown: number, follow: boolean): void;
};

/** Порядок множителей — порядок шагов пайплайна урона (GDD §4.2). */
const FACTORS = [
  'weaponRoll',
  'ilvlScale',
  'atkMultiplier',
  'matchupMultiplier',
  'mitigation',
  'critMultiplier',
  'blockReduction',
] as const;

function factorValue(roll: RollBreakdown, key: (typeof FACTORS)[number]): number {
  // Митигация и блок записаны как ДОЛЯ СНЯТОГО, а множитель — это
  // остаток. Показывать «×0.18» там, где урон умножается на 0.82,
  // значило бы показать число, которое не перемножается.
  if (key === 'mitigation' || key === 'blockReduction') return 1 - roll[key];
  return roll[key];
}

const num = (value: number, digits = 2): string => value.toFixed(digits);

function fighterName(actor: ActorIndex): string {
  return actor === 0 ? t('battle.fighter.you') : t('battle.fighter.enemy');
}

function statusName(status: StatusId): string {
  return t(`status.${status}`);
}

function traitName(trait: TraitId): string {
  return t(`trait.${trait}.name`);
}

export function renderJournal(log: BattleLog, onSeek: (index: number) => void): JournalView {
  const entries = buildJournal(log);
  const list = el('ol', { class: 'journal__list' });
  const rows: HTMLElement[] = [];

  for (const entry of entries) {
    const row = renderRow(entry, onSeek);
    rows.push(row);
    list.append(row);
  }

  if (entries.length === 0) {
    list.append(el('li', { class: 'journal__empty' }, [t('battle.journal.empty')]));
  }

  const element = el('div', { class: 'journal' }, [
    el('h2', { class: 'journal__title' }, [t('battle.journal')]),
    list,
  ]);

  // Сколько строк уже раскрыто. Хранится, чтобы на каждом событии
  // трогать только новые строки, а не пробегать все: событий сотни,
  // а перерисовка идёт по нескольку раз в секунду.
  let revealed = 0;
  const isFuture = (entry: JournalEntry, shown: number): boolean => entry.index >= shown;

  return {
    element,
    reveal(shown: number, follow: boolean): void {
      if (shown === revealed) return;
      const from = Math.min(revealed, shown);
      const to = Math.max(revealed, shown);
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const row = rows[i];
        if (entry === undefined || row === undefined) continue;
        if (entry.index < from - 1 || entry.index > to) continue;
        row.classList.toggle('journal__row--future', isFuture(entry, shown));
      }
      revealed = shown;

      if (!follow) return;
      // Держать последнюю раскрытую строку на виду. Иначе журнал
      // «работает», но игрок смотрит на начало боя, пока идёт конец.
      const last = lastVisible(entries, rows, shown);
      if (last !== null) last.scrollIntoView({ block: 'nearest' });
    },
  };
}

function lastVisible(
  entries: readonly JournalEntry[],
  rows: readonly HTMLElement[],
  shown: number,
): HTMLElement | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry !== undefined && entry.index < shown) return rows[i] ?? null;
  }
  return null;
}

function renderRow(entry: JournalEntry, onSeek: (index: number) => void): HTMLElement {
  const body = renderBody(entry);
  const head = el(
    'button',
    {
      class: 'journal__head',
      type: 'button',
      ...(body === null ? { disabled: 'disabled' } : { 'aria-expanded': 'false' }),
    },
    renderHead(entry),
  );

  const row = el('li', { class: `journal__row journal__row--${entry.kind} journal__row--future` }, [
    head,
    ...(body === null ? [] : [body]),
  ]);

  if (body !== null) {
    head.addEventListener('click', () => {
      const open = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', open ? 'false' : 'true');
      body.hidden = open;
      // Раскрытие — это ещё и «покажи мне этот момент»: журнал читают,
      // чтобы разобраться, а разбираться удобнее, глядя на сцену.
      if (!open) onSeek(entry.index);
    });
  }

  return row;
}

function renderHead(entry: JournalEntry): (string | Node)[] {
  switch (entry.kind) {
    case 'turn':
      // Число — ТИК ДВИЖКА, а не порядковый номер хода, и подписано
      // соответственно. Боец действует раз в ~10 тиков (GDD §4.1),
      // поэтому «Ход 159» врал бы: ходов к этому моменту было
      // полтора десятка. Свою нумерацию клиент не заводит: она была бы
      // величиной, которой нет в логе.
      return [
        el('span', { class: 'journal__tick' }, [
          t('battle.turn', { tick: entry.tick, who: fighterName(entry.actor) }),
        ]),
      ];

    case 'strike': {
      const parts: (string | Node)[] = [
        el('span', { class: 'journal__who' }, [fighterName(entry.actor)]),
        el('span', { class: 'journal__what' }, [t('battle.strike')]),
      ];
      if (entry.crit) parts.push(el('span', { class: 'journal__tag' }, [t('battle.strike.crit')]));
      if (entry.blocked !== null) {
        parts.push(
          el('span', { class: 'journal__tag' }, [
            t('battle.block.amount', { amount: entry.blocked }),
          ]),
        );
      }
      parts.push(
        el('span', { class: 'journal__amount' }, [
          entry.damage === null
            ? t('battle.strike.absorbed')
            : t('battle.damage', { amount: entry.damage }),
        ]),
      );
      if (entry.hpAfter !== null) {
        parts.push(
          el('span', { class: 'journal__hp' }, [t('battle.hpAfter', { hp: entry.hpAfter })]),
        );
      }
      return parts;
    }

    case 'dodge':
      return [
        el('span', { class: 'journal__who' }, [fighterName(entry.actor)]),
        el('span', { class: 'journal__what' }, [t('battle.dodge')]),
      ];

    case 'effects':
      return [
        el('span', { class: 'journal__what' }, [t('battle.effects')]),
        el('span', { class: 'journal__amount' }, [
          entry.total === 0
            ? t('battle.effects.silent')
            : t('battle.effects.total', { amount: entry.total }),
        ]),
        el('span', { class: 'journal__count' }, [
          // Это ЧИСЛО ТИКОВ в свёрнутой строке, а не стаки статуса:
          // ключ у него свой, чтобы одинаковый на вид «×2» не начал
          // однажды означать в двух местах разное.
          t('battle.effects.count', { count: entry.entries.length }),
        ]),
      ];

    case 'event': {
      const event = entry.event;
      switch (event.t) {
        case 'status_apply':
          return [
            el('span', { class: 'journal__what' }, [
              // Порядок «кто: что» выбран не ради красоты: «Яд на {кто}»
              // требует винительного падежа, а подстановка его не даёт —
              // получалось «Яд на Противник».
              t('battle.status.applied', {
                status: statusName(event.status),
                who: fighterName(event.target),
              }),
            ]),
            el('span', { class: 'journal__count' }, [
              event.duration < 0
                ? t('battle.status.endless')
                : t('battle.status.duration', { ticks: event.duration }),
            ]),
          ];
        case 'status_expire':
          return [
            el('span', { class: 'journal__what' }, [
              t('battle.status.expired', {
                status: statusName(event.status),
                who: fighterName(event.target),
              }),
            ]),
          ];
        case 'trait_fire':
          return [
            el('span', { class: 'journal__who' }, [fighterName(event.actor)]),
            el('span', { class: 'journal__what' }, [
              t('battle.trait.fired', { trait: traitName(event.trait) }),
            ]),
          ];
        case 'damage':
          return [
            el('span', { class: 'journal__what' }, [t('battle.reflected')]),
            el('span', { class: 'journal__amount' }, [
              t('battle.damage', { amount: event.amount }),
            ]),
            el('span', { class: 'journal__hp' }, [t('battle.hpAfter', { hp: event.hpAfter })]),
          ];
        case 'death':
          return [
            el('span', { class: 'journal__what' }, [
              t('battle.death', { who: fighterName(event.actor) }),
            ]),
          ];
        default:
          return [el('span', { class: 'journal__what' }, [event.t])];
      }
    }

    default:
      return [];
  }
}

function renderBody(entry: JournalEntry): HTMLElement | null {
  if (entry.kind === 'strike') return renderBreakdown(entry.roll);
  if (entry.kind === 'effects') return renderEffects(entry.entries);
  return null;
}

function renderEffects(entries: readonly EffectEntry[]): HTMLElement {
  const list = el('ul', { class: 'breakdown__list' });

  for (const item of entries) {
    list.append(
      el('li', { class: 'breakdown__item' }, [
        el('span', {}, [statusName(item.status)]),
        el('span', { class: 'breakdown__who' }, [fighterName(item.target)]),
        el('span', { class: 'breakdown__value' }, [
          item.amount === null
            ? t('battle.effects.silent')
            : t('battle.damage', { amount: item.amount }),
        ]),
      ]),
    );
  }

  return el('div', { class: 'breakdown', hidden: 'hidden' }, [list]);
}

/**
 * Разбор броска: все множители и их произведение.
 *
 * Произведение считается В ТОМ ЖЕ ПОРЯДКЕ, что и в движке (шаги 3–7,
 * затем блок). Порядок умножения в плавающей точке значим, и «почти
 * то же самое» здесь дало бы расхождение в последнем знаке — то есть
 * ложную тревогу в строке несовпадения.
 */
function renderBreakdown(roll: RollBreakdown): HTMLElement {
  const rows = el('dl', { class: 'breakdown__grid' });
  let product = roll.weaponRoll;

  for (const key of FACTORS) {
    const value = factorValue(roll, key);
    if (key !== 'weaponRoll') product *= value;
    rows.append(
      el('dt', {}, [t(`battle.roll.${key}`)]),
      el('dd', {}, [key === 'weaponRoll' ? num(value) : `× ${num(value)}`]),
    );
  }

  const final = Math.max(0, Math.round(product));
  const matches = final === roll.final;

  rows.append(
    el('dt', { class: 'breakdown__sum' }, [t('battle.roll.product')]),
    el('dd', { class: 'breakdown__sum' }, [num(product)]),
    el('dt', { class: 'breakdown__sum' }, [t('battle.roll.final')]),
    el('dd', { class: 'breakdown__sum' }, [String(roll.final)]),
  );

  const children: (string | Node)[] = [
    rows,
    el('p', { class: 'breakdown__hint' }, [t('battle.roll.hint')]),
  ];
  if (!matches) {
    // Не подгонять и не прятать: расхождение означает, что либо здесь
    // ошибка показа, либо в движке — и то и другое игрок должен видеть.
    children.push(
      el('p', { class: 'breakdown__mismatch', role: 'alert' }, [t('battle.roll.mismatch')]),
    );
  }

  return el('div', { class: 'breakdown', hidden: 'hidden' }, children);
}
