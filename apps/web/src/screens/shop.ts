import type { ShopResponse, ShopSlot } from '@extramundum/shared';

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
