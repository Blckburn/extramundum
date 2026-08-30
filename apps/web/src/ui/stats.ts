import { balance } from '@extramundum/data';

import { el } from '../dom.ts';
import { t } from '../i18n.ts';

/**
 * Объяснение характеристик. GDD §4.1, §4.2.
 *
 * ЗАЧЕМ ЭТО ЕСТЬ. На первых живых сессиях карты драфта выбирались
 * наугад: «непонятно, что дают статы». Числа при этом были измерены
 * и записаны — в §4.1 стоит, что очко SPD втрое дороже очка ATK, —
 * но до экрана не доходили.
 *
 * Формулировки карт при этом НЕ МЕНЯЮТСЯ: карта говорит «+3 ATK»,
 * а не «+4% урона». Меняется объяснение системы, а не подпись эффекта:
 * иначе пришлось бы считать проценты в клиенте, а он не считает ничего.
 */

/** Цена очка относительно ATK. Из данных, а не из строки локали. */
const price = balance.progression.statPrice as Readonly<Record<string, number>>;

/** У каких характеристик цена вообще определена: только у четырёх базовых. */
export function statPrice(stat: string): number | undefined {
  return price[stat];
}

/**
 * Строка «что этот стат делает», при наличии — с ценой очка.
 *
 * Возвращает `null`, если объяснения нет: молча показать пустую подпись
 * хуже, чем не показать ничего, — игрок решит, что стат ничего не даёт.
 */
export function statExplanation(stat: string): HTMLElement | null {
  const about = t(`stat.about.${stat}`);
  // `t` возвращает ключ, если строки нет. Это и есть признак отсутствия.
  if (about === `stat.about.${stat}`) return null;

  const cost = statPrice(stat);

  return el('span', { class: 'stat__about' }, [
    about,
    ...(cost === undefined || cost === 1
      ? []
      : [
          el('strong', { class: 'stat__price', title: t('stat.priceHint') }, [
            ` ${t('stat.price', { price: cost })}`,
          ]),
        ]),
  ]);
}

/** Список характеристик для экрана персонажа: что делает и сколько стоит. */
export function statsPanel(order: readonly string[]): HTMLElement {
  return el('section', { class: 'chars' }, [
    el('h2', { class: 'chars__title' }, [t('inventory.chars')]),
    el(
      'ul',
      { class: 'chars__list' },
      order.flatMap((stat) => {
        const about = statExplanation(stat);
        if (about === null) return [];
        return [
          el('li', { class: 'chars__row' }, [
            el('span', { class: 'chars__name' }, [t(`stat.${stat}`)]),
            about,
          ]),
        ];
      }),
    ),
  ]);
}
