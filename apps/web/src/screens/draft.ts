import type { CardEffects, DraftOption, DraftResponse, DraftView } from '@extramundum/shared';

import { api, ApiClientError } from '../api.ts';
import { clear, el } from '../dom.ts';
import { t } from '../i18n.ts';
import { renderIcon } from '../ui/icon.ts';

/**
 * Драфт уровня. GDD §5.2.
 *
 * ЭКРАН НЕ РЕШАЕТ НИЧЕГО. Какие карты предложены, чем они открылись
 * и что засчитано в билд — приходит с сервера. Клиент отправляет обратно
 * ОДИН идентификатор; карту, которой не показывали, сервер не примет,
 * поэтому подделка невозможна не силами интерфейса, а по устройству.
 *
 * Числа берутся из `effects`, а не из строк локали: коэффициент, вписанный
 * в текст, разошёлся бы с данными молча (инвариант 5). Локаль даёт имя
 * и смысл, данные — величину.
 */

type Surface = {
  readonly root: HTMLElement;
  readonly onDone: () => void;
};

export function renderDraft(root: HTMLElement, onDone: () => void): void {
  void render({ root, onDone });
}

/** Порядок ключей эффекта на карточке. Фиксированный: карточки читаются рядом. */
const EFFECT_ORDER = [
  'atk',
  'def',
  'agi',
  'spd',
  'armor',
  'accuracy',
  'pathBonusHp',
  'critBonus',
] as const satisfies readonly (keyof CardEffects)[];

/** Строка эффекта: «+3 ATK». Крит — доля, поэтому показывается процентом. */
function effectLines(effects: CardEffects): string[] {
  const out: string[] = [];
  for (const key of EFFECT_ORDER) {
    const value = effects[key];
    if (value === undefined || value === 0) continue;
    const shown =
      key === 'critBonus' ? `${Math.round(value * 100)}%` : `${value > 0 ? '+' : ''}${value}`;
    out.push(`${shown} ${t(`stat.${key}`)}`);
  }
  return out;
}

async function render(surface: Surface): Promise<void> {
  clear(surface.root);
  const host = el('main', { class: 'screen screen--draft' });
  surface.root.append(host);

  const back = el('button', { class: 'button button--ghost', type: 'button' }, [t('action.back')]);
  back.addEventListener('click', surface.onDone);

  const fail = (err: unknown): void => {
    const key = err instanceof ApiClientError ? err.messageKey : 'error.internal';
    clear(host);
    host.append(el('p', { class: 'draft__error' }, [t(key)]), back);
  };

  let state: DraftResponse;
  try {
    state = await api.draft();
  } catch (err) {
    fail(err);
    return;
  }

  /**
   * Отправить выбор.
   *
   * Блокируются только КАРТОЧКИ: второй клик по соседней означал бы
   * второй уровень, разобранный вслепую. «Назад» остаётся живым —
   * выбор уже ушёл на сервер и применится независимо от того, смотрит
   * ли игрок на этот экран, а запертая кнопка выхода — это ловушка.
   */
  const choose = (choice: string): void => {
    for (const button of host.querySelectorAll('.draft__option')) {
      button.setAttribute('disabled', '');
    }
    api.pickDraft({ choice }).then(
      (next) => {
        state = next;
        draw();
      },
      (err: unknown) => {
        fail(err);
      },
    );
  };

  function draw(): void {
    clear(host);
    const view = state.draft;

    if (view.level === null) {
      host.append(
        el('h1', { class: 'screen__title' }, [t('draft.title')]),
        el('p', { class: 'draft__lead' }, [t('draft.nothing')]),
        progressBar(),
        back,
      );
      return;
    }

    host.append(
      el('h1', { class: 'screen__title' }, [t('draft.level', { level: view.level })]),
      el('p', { class: 'draft__lead' }, [
        t(view.kind === 'trait' ? 'draft.leadTrait' : 'draft.leadCard'),
      ]),
      progressBar(),
      leans(view),
      el(
        'ul',
        { class: 'draft__options' },
        view.options.map((option) => optionCard(option, view.kind)),
      ),
      // Сколько уровней ещё ждёт: разбираются они по одному и по порядку,
      // потому что выбор за третий уровень открывает колоду четвёртого.
      view.pending > 1
        ? el('p', { class: 'draft__pending' }, [t('draft.pending', { count: view.pending - 1 })])
        : '',
      back,
    );
  }

  /** Полоса опыта. Пороги считает сервер — клиент кривую не повторяет. */
  function progressBar(): HTMLElement {
    const { level, xp, xpAtLevel, xpForNext } = state.progress;

    if (xpForNext === null) {
      return el('p', { class: 'draft__xp draft__xp--cap' }, [t('draft.cap', { level })]);
    }

    const span = Math.max(1, xpForNext - xpAtLevel);
    /* ЗАЖИМАЕТСЯ И ЧИСЛО, а не только ширина полосы. Пока драфты
       не разобраны, уровень в базе отстаёт от заработанного, и сырая
       разность даёт «650 из 100» — вид ошибки там, где на самом деле
       уровень просто полон и ждёт выбора. */
    const done = Math.max(0, Math.min(span, xp - xpAtLevel));
    const fill = el('span', { class: 'draft__xpfill' });
    fill.style.width = `${Math.round((done / span) * 100)}%`;

    return el('div', { class: 'draft__xp' }, [
      el('div', { class: 'draft__xpbar' }, [fill]),
      el('span', { class: 'draft__xptext' }, [t('draft.xp', { level, done, span })]),
    ]);
  }

  /**
   * Наклоны билда — то, ПО ЧЕМУ отфильтрована колода.
   *
   * Показывается, потому что иначе фильтр невидим: игрок видел бы, что
   * карты «какие-то другие», и не знал бы почему. Спрятанное правило —
   * это правило, которого для игрока нет.
   */
  function leans(view: DraftView): HTMLElement {
    return el('div', { class: 'draft__leans', title: t('draft.leansHint') }, [
      el('span', { class: 'draft__leansLabel' }, [t('draft.leans')]),
      ...(['atk', 'def', 'agi', 'spd'] as const).map((key) =>
        el('span', { class: `draft__lean draft__lean--${key}` }, [
          `${t(`stat.${key}`)} ${view.leans[key]}`,
        ]),
      ),
    ]);
  }

  function optionCard(option: DraftOption, kind: DraftView['kind']): HTMLElement {
    const isTrait = kind === 'trait';
    const nameKey = isTrait ? `trait.${option.id}.name` : `card.${option.id}.name`;
    const descKey = isTrait ? `trait.${option.id}.desc` : `card.${option.id}.desc`;

    const button = el(
      'button',
      {
        class: `draft__option${option.tier === null ? '' : ` draft__option--${option.tier}`}`,
        type: 'button',
      },
      [
        // У трейтов иконка есть с M1c, у карт её нет: карта — это число
        // и строка, а не сущность на арене.
        isTrait ? renderIcon(`trait.${option.id}`, 128, t(nameKey)) : '',
        el('span', { class: 'draft__optionName' }, [t(nameKey)]),
        option.tier === null || option.tier === 'base'
          ? ''
          : el('span', { class: 'draft__tier' }, [t(`draft.tier.${option.tier}`)]),
        el('span', { class: 'draft__optionDesc' }, [t(descKey)]),
        ...(isTrait
          ? []
          : effectLines(option.effects).map((line) =>
              el('span', { class: 'draft__effect' }, [line]),
            )),
      ],
    );

    button.addEventListener('click', () => {
      choose(option.id);
    });
    return button;
  }

  draw();
}
