import {
  MATERIAL_KEYS,
  type ItemView,
  type Materials,
  type SmithCost,
  type SmithOffer,
  type SmithViewResponse,
} from '@extramundum/shared';

import { api, ApiClientError } from '../api.ts';
import { clear, el } from '../dom.ts';
import { t } from '../i18n.ts';
import { affixText } from '../ui/affix.ts';
import { renderIcon } from '../ui/icon.ts';

/**
 * Кузнец. GDD §6.3, §5.2.
 *
 * КЛИЕНТ НЕ СЧИТАЕТ НИЧЕГО: ни цены, ни шанса, ни того, во что
 * превратится аффикс. Всё приходит готовым — у клиента нет ни баланса,
 * ни формул, и заводить их здесь значило бы завести вторую экономику,
 * которая разойдётся с настоящей молча.
 *
 * ЦЕНА И РИСК СТОЯТ НА КНОПКЕ, а не в подсказке. Улучшение выше +5
 * необратимо отнимает уровень при провале, и узнавать об этом после
 * нажатия игрок не должен.
 */
export function renderSmith(root: HTMLElement, onBack: () => void): void {
  clear(root);

  const head = el('div', { class: 'smith__head' });
  const list = el('div', { class: 'smith__list' });
  const detail = el('aside', { class: 'smith__detail' });
  const notice = el('p', { class: 'smith__notice', role: 'status' });
  const respecRow = el('div', { class: 'smith__respec' });

  const back = el('button', { class: 'button button--ghost', type: 'button' }, [t('action.back')]);
  back.addEventListener('click', onBack);

  root.append(
    el('main', { class: 'screen screen--smith' }, [
      el('header', { class: 'smith__top' }, [
        el('h1', { class: 'smith__title' }, [t('smith.title')]),
        head,
      ]),
      el('div', { class: 'smith__body' }, [list, detail]),
      respecRow,
      el('div', { class: 'smith__bar screen__actions' }, [notice, back]),
    ]),
  );

  let data: SmithViewResponse | null = null;
  let selectedId: string | null = null;

  const refresh = async (): Promise<void> => {
    try {
      data = await api.smith();
    } catch (err) {
      notice.textContent = t(err instanceof ApiClientError ? err.messageKey : 'error.internal');
      return;
    }
    draw();
  };

  /** Материалы строкой. Пустой набор — пустая строка, а не «0 лома». */
  function materialsText(materials: Materials): string {
    return MATERIAL_KEYS.filter((key) => (materials[key] ?? 0) > 0)
      .map((key) => `${t(`material.${key}`)} × ${String(materials[key] ?? 0)}`)
      .join(', ');
  }

  function costText(cost: SmithCost): string {
    const materials = materialsText(cost.materials);
    return materials === ''
      ? t('smith.cost.goldOnly', { gold: cost.gold })
      : t('smith.cost', { gold: cost.gold, materials });
  }

  function draw(): void {
    if (data === null) return;

    clear(head);
    head.append(
      el('span', { class: 'smith__gold' }, [t('smith.purse', { gold: data.gold })]),
      el('span', { class: 'smith__mats' }, [materialsText(data.materials)]),
    );

    drawList();
    drawDetail();
    drawRespec();
  }

  function drawList(): void {
    clear(list);
    if (data === null) return;

    if (data.offers.length === 0) {
      list.append(el('p', { class: 'smith__empty' }, [t('smith.empty')]));
      return;
    }

    for (const offer of data.offers) {
      const item = offer.item;
      const cell = el(
        'button',
        {
          class: `smith__cell smith__cell--${item.rarity}${item.id === selectedId ? ' smith__cell--selected' : ''}`,
          type: 'button',
          title: t(`item.${item.baseKey}`),
        },
        [
          renderIcon(item.baseKey, 128, t(`item.${item.baseKey}`)),
          el('span', { class: 'smith__cellName' }, [t(`item.${item.baseKey}`)]),
          // Уровень улучшения виден В СПИСКЕ: иначе «что я уже качал»
          // выясняется перебором карточек.
          ...(item.upgradeLevel > 0
            ? [
                el('span', { class: 'smith__plus' }, [
                  t('item.upgradeLevel', { level: item.upgradeLevel }),
                ]),
              ]
            : []),
        ],
      );
      cell.addEventListener('click', () => {
        selectedId = item.id;
        draw();
      });
      list.append(cell);
    }
  }

  function selected(): SmithOffer | null {
    if (data === null || selectedId === null) return null;
    return data.offers.find((offer) => offer.item.id === selectedId) ?? null;
  }

  /** Кнопка операции. Гасится и ценой, и запросом — по разным причинам. */
  function action(label: string, cost: SmithCost, run: () => Promise<string>): HTMLElement {
    const button = el('button', { class: 'button button--small', type: 'button' }, [
      label,
    ]) as HTMLButtonElement;

    // Не хватает — кнопка мертва, и рядом сказано почему. Молча гасить
    // значило бы оставить игрока гадать, что не так.
    button.disabled = !cost.affordable;
    button.addEventListener('click', () => {
      button.disabled = true;
      void run()
        .then(async (message) => {
          notice.textContent = message;
          await refresh();
        })
        .catch((err: unknown) => {
          notice.textContent = t(err instanceof ApiClientError ? err.messageKey : 'error.internal');
          button.disabled = false;
        });
    });

    return el('div', { class: 'smith__op' }, [
      button,
      el('span', { class: 'smith__price' }, [costText(cost)]),
      ...(cost.affordable ? [] : [el('span', { class: 'smith__short' }, [t('smith.cantAfford')])]),
    ]);
  }

  function drawDetail(): void {
    clear(detail);
    const offer = selected();
    if (offer === null) {
      detail.append(el('p', { class: 'smith__pick' }, [t('smith.pick')]));
      return;
    }

    const item = offer.item;
    detail.append(
      el('h2', { class: `smith__name smith__name--${item.rarity}` }, [
        `${t(`item.${item.baseKey}`)}${item.upgradeLevel > 0 ? ` ${t('item.upgradeLevel', { level: item.upgradeLevel })}` : ''}`,
      ]),
      el('p', { class: 'smith__sub' }, [
        `${t(`rarity.${item.rarity}`)} · ${t('item.ilvl', { ilvl: item.ilvl })}`,
      ]),
    );

    /* УЛУЧШЕНИЕ. Риск написан на кнопке рядом с ценой: провал выше +5
       отнимает уровень, и узнавать об этом после нажатия нельзя. */
    if (offer.upgrade === null) {
      detail.append(el('p', { class: 'smith__note' }, [t('smith.upgrade.max')]));
    } else {
      const up = offer.upgrade;
      detail.append(
        action(t('smith.upgrade', { to: up.to }), up, async () => {
          const result = await api.smithUpgrade({ itemId: item.id });
          return result.succeeded
            ? t('smith.upgrade.done', { level: result.item.upgradeLevel })
            : t('smith.upgrade.failed', { level: result.item.upgradeLevel });
        }),
        el('p', { class: up.success >= 1 ? 'smith__note' : 'smith__note smith__note--risk' }, [
          up.success >= 1
            ? t('smith.upgrade.safe')
            : t('smith.upgrade.risk', { percent: Math.round(up.success * 100) }),
        ]),
      );
    }

    /* ПОВЫШЕНИЕ РЕДКОСТИ. Отсутствие записи в балансе — это отказ,
       а не нулевая цена, и сервер присылает `null`. */
    if (offer.rarityUp === null) {
      detail.append(el('p', { class: 'smith__note' }, [t('smith.rarityUp.max')]));
    } else {
      const up = offer.rarityUp;
      detail.append(
        action(t('smith.rarityUp', { to: t(`rarity.${up.to}`) }), up, async () => {
          await api.smithRarityUp({ itemId: item.id });
          return t('smith.rarityUp.done');
        }),
      );
    }

    /* ПЕРЕКОВКА — ПО АФФИКСУ, а не по предмету: §6.3 называет её
       точечным улучшением, и кнопка «перековать» без выбора какого
       вернула бы перекатывание всего, то есть ровно v1.0. */
    if (offer.reforge !== null && item.affixes.length > 0) {
      const reforge = offer.reforge;
      detail.append(el('h3', { class: 'smith__subtitle' }, [t('smith.reforge')]));
      item.affixes.forEach((affix, index) => {
        detail.append(
          action(affixLabel(affix), reforge, async () => {
            await api.smithReforge({ itemId: item.id, affixIndex: index });
            return t('smith.reforge.done');
          }),
        );
      });
      detail.append(el('p', { class: 'smith__note' }, [t('smith.reforge.hint')]));
    }
  }

  /** Подпись кнопки перековки: что именно перековывается. */
  function affixLabel(affix: ItemView['affixes'][number]): string {
    return `${affixText(affix)} · ${affix.tier}`;
  }

  function drawRespec(): void {
    clear(respecRow);
    if (data === null) return;
    const respec = data.respec;

    if (respec.picks === 0) {
      respecRow.append(el('p', { class: 'smith__note' }, [t('smith.respec.none')]));
      return;
    }

    respecRow.append(
      el('p', { class: 'smith__note' }, [
        t('smith.respec.price', { gold: respec.gold, picks: respec.picks }),
      ]),
      action(t('smith.respec'), respec, async () => {
        if (
          !globalThis.confirm(t('smith.respec.confirm', { picks: respec.picks, gold: respec.gold }))
        ) {
          return '';
        }
        await api.smithRespec();
        return t('smith.respec.done');
      }),
    );
  }

  void refresh();
}
