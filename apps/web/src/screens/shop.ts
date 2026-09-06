import type { FlaskOffer, ShopResponse, ShopSlot, StashTabOffer } from '@extramundum/shared';

import { api, ApiClientError } from '../api.ts';
import { clear, el } from '../dom.ts';
import { t } from '../i18n.ts';
import { affixText } from '../ui/affix.ts';
import { renderIcon } from '../ui/icon.ts';

/**
 * Лавка. GDD §6.3.
 *
 * УРОВЕНЬ АССОРТИМЕНТА НАПИСАН НА ЭКРАНЕ, а не подразумевается. Он
 * приходит от самого глубокого ПРОЙДЕННОГО участка, а не от уровня
 * игрока, и без строки об этом «почему тут только ilvl 8» остаётся
 * без ответа — игрок решает, что лавка сломана.
 *
 * Клиент не считает ни цены, ни того, что в слоте: и состав, и цена
 * выводятся сервером из серверного сида дня.
 */
export function renderShop(root: HTMLElement, onBack: () => void): void {
  clear(root);

  const head = el('div', { class: 'shop__head' });
  const grid = el('div', { class: 'shop__grid' });
  const flaskBox = el('section', { class: 'shop__flasks' });
  const notice = el('p', { class: 'shop__notice', role: 'status' });

  const back = el('button', { class: 'button button--ghost', type: 'button' }, [t('action.back')]);
  back.addEventListener('click', onBack);

  root.append(
    el('main', { class: 'screen screen--shop' }, [
      el('header', { class: 'shop__top' }, [
        el('h1', { class: 'shop__title' }, [t('shop.title')]),
        head,
      ]),
      grid,
      flaskBox,
      el('p', { class: 'shop__hint' }, [t('shop.refresh')]),
      el('div', { class: 'shop__bar screen__actions' }, [notice, back]),
    ]),
  );

  let data: ShopResponse | null = null;

  const refresh = async (): Promise<void> => {
    try {
      data = await api.shop();
    } catch (err) {
      notice.textContent = t(err instanceof ApiClientError ? err.messageKey : 'error.internal');
      return;
    }
    draw();
  };

  function draw(): void {
    if (data === null) return;

    clear(head);
    head.append(
      el('span', { class: 'shop__gold' }, [t('shop.purse', { gold: data.gold })]),
      el('span', { class: 'shop__level' }, [t('shop.level', { level: data.level })]),
    );

    clear(grid);
    for (const slot of data.slots) grid.append(card(slot));
    grid.append(el('p', { class: 'shop__hint' }, [t('shop.level.hint')]));

    clear(flaskBox);
    flaskBox.append(el('h2', { class: 'shop__subtitle' }, [t('shop.flasks')]));
    for (const flask of data.flasks) flaskBox.append(flaskCard(flask));
    flaskBox.append(tabsCard(data.stashTabs));
  }

  /**
   * Вкладки стеша. GDD §6.3.
   *
   * ЕДИНСТВЕННЫЙ СТОК, КОТОРЫЙ НЕ НАСЫЩАЕТСЯ по смыслу, поэтому он
   * стоит на том же прилавке, а не прячется на экране снаряжения:
   * решение «улучшить меч или купить место» — это решение, и обе цены
   * должны быть видны разом.
   */
  function tabsCard(tabs: StashTabOffer): HTMLElement {
    const buy = el('button', { class: 'button button--small', type: 'button' }, [
      tabs.price === null ? t('shop.tabs.all') : t('shop.tabs.buy', { price: tabs.price }),
    ]) as HTMLButtonElement;

    buy.disabled = !tabs.affordable;
    buy.addEventListener('click', () => {
      buy.disabled = true;
      void api
        .shopStashTab()
        .then(async (result) => {
          notice.textContent = t('shop.tabs.bought', { capacity: result.capacity });
          await refresh();
        })
        .catch((err: unknown) => {
          notice.textContent = t(err instanceof ApiClientError ? err.messageKey : 'error.internal');
          buy.disabled = false;
        });
    });

    return el('article', { class: 'shop__card' }, [
      el('h3', { class: 'shop__name' }, [t('shop.tabs')]),
      el('p', { class: 'shop__sub' }, [
        t('shop.tabs.have', { owned: tabs.owned, capacity: tabs.capacity }),
      ]),
      ...(tabs.price === null
        ? []
        : [el('p', { class: 'shop__sub' }, [t('shop.tabs.adds', { slots: tabs.slotsPerTab })])]),
      el('div', { class: 'shop__actions' }, [
        buy,
        ...(tabs.affordable || tabs.price === null
          ? []
          : [el('span', { class: 'shop__short' }, [t('shop.cantAfford')])]),
      ]),
    ]);
  }

  /**
   * Фляга на прилавке. GDD §7.2.
   *
   * ДИАПАЗОН И ОБЕ СТОРОНЫ ПОБОЧНОГО ЭФФЕКТА НАПИСАНЫ, а не спрятаны:
   * выбор между дешёвой предсказуемой и дорогой с двумя сторонами —
   * это и есть решение, ради которого тиры существуют. Без обеих цифр
   * игрок покупает самую дорогую и не понимает, за что заплатил.
   */
  function flaskCard(flask: FlaskOffer): HTMLElement {
    const lo = Math.round(flask.restore[0] * 100);
    const hi = Math.round(flask.restore[1] * 100);

    const buy = el('button', { class: 'button button--small', type: 'button' }, [
      flask.charges >= flask.max
        ? t('shop.flask.full')
        : t('shop.flask.buy', { price: flask.price }),
    ]) as HTMLButtonElement;

    buy.disabled = !flask.affordable;
    buy.addEventListener('click', () => {
      buy.disabled = true;
      void api
        .shopFlask({ tier: flask.id })
        .then(async () => {
          notice.textContent = t('shop.flask.bought', { name: t(`flask.${flask.id}`) });
          await refresh();
        })
        .catch((err: unknown) => {
          notice.textContent = t(err instanceof ApiClientError ? err.messageKey : 'error.internal');
          buy.disabled = false;
        });
    });

    return el('article', { class: 'shop__card' }, [
      el('h3', { class: 'shop__name' }, [
        t('shop.flask.have', {
          name: t(`flask.${flask.id}`),
          charges: flask.charges,
          max: flask.max,
        }),
      ]),
      el('p', { class: 'shop__sub' }, [t('shop.flask.restore', { lo, hi })]),
      el('p', { class: 'shop__sub' }, [
        flask.side === null
          ? t('shop.flask.plain')
          : t('shop.flask.side', {
              good: t(`status.${flask.side.good}`),
              bad: t(`status.${flask.side.bad}`),
              percent: Math.round(flask.side.chance * 100),
            }),
      ]),
      el('div', { class: 'shop__actions' }, [
        buy,
        ...(flask.affordable || flask.charges >= flask.max
          ? []
          : [el('span', { class: 'shop__short' }, [t('shop.cantAfford')])]),
      ]),
    ]);
  }

  function card(slot: ShopSlot): HTMLElement {
    const item = slot.item;

    const buy = el('button', { class: 'button button--small', type: 'button' }, [
      slot.sold ? t('shop.sold') : t('shop.buy', { price: slot.price }),
    ]) as HTMLButtonElement;

    // Купленный слот НЕ ИСЧЕЗАЕТ с полки: «куда делся тот меч»
    // не должно быть вопросом. Кнопка мертва, надпись объясняет.
    buy.disabled = slot.sold || !slot.affordable;
    buy.addEventListener('click', () => {
      buy.disabled = true;
      void api
        .shopBuy({ slot: slot.slot })
        .then(async (result) => {
          notice.textContent = t('shop.bought', { name: t(`item.${result.item.baseKey}`) });
          await refresh();
        })
        .catch((err: unknown) => {
          notice.textContent = t(err instanceof ApiClientError ? err.messageKey : 'error.internal');
          buy.disabled = false;
        });
    });

    return el('article', { class: `shop__card shop__card--${item.rarity}` }, [
      el('div', { class: 'shop__cardHead' }, [
        renderIcon(item.baseKey, 128, t(`item.${item.baseKey}`)),
        el('div', {}, [
          el('h2', { class: `shop__name shop__name--${item.rarity}` }, [t(`item.${item.baseKey}`)]),
          el('p', { class: 'shop__sub' }, [
            `${t(`rarity.${item.rarity}`)} · ${t('item.ilvl', { ilvl: item.ilvl })} · ${t(`slot.${item.slot}`)}`,
          ]),
        ]),
      ]),
      el(
        'ul',
        { class: 'shop__affixes' },
        item.affixes.map((affix) => el('li', {}, [`${affixText(affix)} · ${affix.tier}`])),
      ),
      el('div', { class: 'shop__actions' }, [
        buy,
        ...(slot.sold || slot.affordable
          ? []
          : [el('span', { class: 'shop__short' }, [t('shop.cantAfford')])]),
      ]),
    ]);
  }

  void refresh();
}
