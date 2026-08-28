import { cardSpecSchema, type CardSpec } from '@extramundum/shared';

import cardsJson from './cards.json' with { type: 'json' };

/**
 * Колода драфта. GDD §5.2.
 *
 * Разбирается схемой ЗДЕСЬ, один раз, как палитра, риги и монстры:
 * кривая запись падает на сборке, а не превращается в карту, которая
 * на экране обещает одно, а бойцу даёт другое.
 */
export const CARDS: readonly CardSpec[] = cardsJson.cards.map((card) => cardSpecSchema.parse(card));

const byId = new Map(CARDS.map((card) => [card.id, card]));

/**
 * Карта по идентификатору. Неизвестный ключ — ошибка ДАННЫХ, а не тихий
 * null: карта, которой нет, не должна превращаться в выбор без эффекта.
 */
export function cardSpec(id: string): CardSpec {
  const card = byId.get(id);
  if (card === undefined) throw new Error(`нет карты «${id}» в cards.json`);
  return card;
}

export function hasCard(id: string): boolean {
  return byId.has(id);
}
