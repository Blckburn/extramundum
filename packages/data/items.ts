import { itemBaseSchema, type EquipmentSlot, type ItemBase } from '@extramundum/shared';

import basesJson from './items/bases.json' with { type: 'json' };

/**
 * Базы предметов. GDD §5.3, §6.1.
 *
 * Разбираются схемой ЗДЕСЬ, один раз, как палитра и риги: кривая запись
 * падает на сборке, а не превращается в предмет с `undefined` в уроне
 * у игрока.
 */
export const ITEM_BASES: readonly ItemBase[] = basesJson.bases.map((base) =>
  itemBaseSchema.parse(base),
);

const byKey = new Map(ITEM_BASES.map((base) => [base.key, base]));

/**
 * База по ключу. Неизвестный ключ — ошибка данных, а не тихий null.
 *
 * Предмет в БД ссылается на базу строкой (`items.base_key`). Если базу
 * переименовали или удалили, у игрока в инвентаре лежит запись, которую
 * нечем истолковать, и молча подставить «что-нибудь» — худшее из
 * возможного: он увидит чужие числа на своём предмете.
 */
export function itemBase(key: string): ItemBase {
  const base = byKey.get(key);
  if (base === undefined) throw new Error(`нет базы предмета «${key}» в items/bases.json`);
  return base;
}

export function hasItemBase(key: string): boolean {
  return byKey.has(key);
}

/** Базы, которые могут выпасть на данном уровне предмета. */
export function basesForSlot(slot: EquipmentSlot, ilvl: number): readonly ItemBase[] {
  return ITEM_BASES.filter((base) => base.slot === slot && base.minIlvl <= ilvl);
}

/** Все ключи баз — для манифеста иконок и тестов. */
export const ITEM_BASE_KEYS: readonly string[] = ITEM_BASES.map((base) => base.key);
