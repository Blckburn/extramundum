import { iconPath, iconSymbol } from '@extramundum/data/assets';

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

  /* ВТОРОЙ УРОВЕНЬ: векторный силуэт. Он временный — по ART-BIBLE §7
     его заменят гравюрные растры, — но он уже отвечает на вопрос
     «что это», чего квадрат с буквой не делает.

     `<use>` ссылается на символ в спрайте, который вкладывается
     в документ один раз (см. `sprite.ts`). Цвета внутри символов —
     переменные палитры, поэтому иконка красится темой, а не хранит
     свои хексы. */
  const symbol = iconSymbol(key);
  if (symbol !== null) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon icon--symbol');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', alt || key);
    svg.dataset.iconKey = key;
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${symbol}`);
    svg.append(use);
    return svg as unknown as HTMLElement;
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
