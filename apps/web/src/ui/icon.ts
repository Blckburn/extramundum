import { iconPath } from '@extramundum/data/assets';

import { el } from '../dom.ts';

/**
 * Иконка сущности либо плейсхолдер вместо неё.
 *
 * ART-BIBLE §7: «Пока ассета нет — плейсхолдер: цветной квадрат с первой
 * буквой типа. Игра должна собираться и запускаться с нулём готовых
 * иконок». Отсутствие картинки — нормальное состояние на этом этапе,
 * а не ошибка: рисование идёт параллельно разработке.
 *
 * Цвет плейсхолдера выводится из ключа детерминированно, поэтому кинжал
 * всегда одного цвета, а топор — другого. Это не украшение: в списке
 * из тридцати предметов одинаковые серые квадраты неразличимы, а
 * стабильно разные — уже читаются.
 */
export type IconSize = 128 | 256;

/**
 * Первая буква ТИПА: `weapon.sword` -> «S», `slot.helmet` -> «H».
 *
 * Берётся идентификатор, а не категория. Категория одинакова у всей
 * группы, и восемь слотов подряд превратились бы в восемь одинаковых
 * «S» — плейсхолдер, который ничего не различает, бесполезен.
 */
function letterOf(key: string): string {
  const id = key.includes('.') ? (key.split('.').at(-1) ?? key) : key;
  return (id[0] ?? '?').toUpperCase();
}

/** Стабильный оттенок из ключа. Не криптография — просто разброс. */
function hueOf(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) % 360_000;
  }
  return hash % 360;
}

export function renderIcon(key: string, size: IconSize = 128, alt = ''): HTMLElement {
  const path = iconPath(key);

  if (path !== null) {
    return el('img', {
      class: 'icon',
      src: `/assets/${path}`,
      width: String(size),
      height: String(size),
      alt,
      loading: 'lazy',
      decoding: 'async',
    });
  }

  const hue = hueOf(key);

  /**
   * В `style` идёт ТОЛЬКО оттенок — он вычисляется из ключа, и записать
   * его классом нечем. Размер уходит в CSS, и это исправление, а не вкус:
   * инлайновый стиль сильнее любого правила из файла, поэтому прежний
   * `width:128px` побеждал `.slots .icon { width: 3rem }` — слоты
   * деревни рисовались вчетверо крупнее задуманного, и это было видно
   * только глазами. В M2b то же самое раздуло иконки статусов на пол-арены.
   *
   * `size` остаётся размером АССЕТА (WebP 128 и 256), а не размером
   * на экране: это разные величины, и путать их — как раз то, что
   * привело к прежнему поведению.
   */
  return el(
    'span',
    {
      class: 'icon icon--placeholder',
      style: `--icon-hue:${hue}`,
      role: 'img',
      'aria-label': alt || key,
      'data-icon-key': key,
    },
    [letterOf(key)],
  );
}
