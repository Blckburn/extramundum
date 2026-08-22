import { balance as balanceData, ITEM_BASES } from '@extramundum/data';
import { EQUIPMENT_SLOTS, lootBalanceSchema, RARITIES, type Rarity } from '@extramundum/shared';
import { generateItem } from '@extramundum/sim';

import type { NewItem } from './repository.ts';

/**
 * Набор предметов для проверки интерфейса. НЕ ЧАСТЬ ИГРЫ.
 *
 * Выдаётся только при `DEV_STARTING_KIT=true`. По умолчанию новый
 * аккаунт не получает ничего, и это правильно: изгнанного вывели
 * за стену ни с чем (LORE §2), а источник лута — рейды из M3b.
 *
 * Набор существует затем, что без предметов нельзя проверить ни фильтры,
 * ни сортировку, ни массовую продажу: интерфейс, у которого нечего
 * фильтровать, формально работает и не проверен ничем.
 *
 * ДЕТЕРМИНИРОВАН от номера изгнанного: один и тот же аккаунт получает
 * один и тот же набор при каждом пересоздании базы, и скриншот
 * вчерашнего дня сравним с сегодняшним.
 */

const loot = lootBalanceSchema.parse(balanceData.items);

/** Сколько всего предметов. Хватает, чтобы фильтры было чем нагрузить. */
const KIT_SIZE = 40;

/** Уровни предметов набора: по одному ниже каждой границы тира и выше. */
const ILVLS = [1, 8, 16, 25, 34, 40];

export function startingKit(exileNumber: number): readonly NewItem[] {
  const out: NewItem[] = [];

  // Первые восемь — по одному на слот, чтобы было что надеть сразу
  // и чтобы каждый слот рига получил видимый предмет.
  for (const slot of EQUIPMENT_SLOTS) {
    const item = generateItem(`kit:${exileNumber}:${slot}`, { ilvl: 12, slot }, loot, ITEM_BASES);
    out.push({ ...item, container: 'inv' });
  }

  // Остальное — в стеш, вперемешку по уровням и редкостям: именно на
  // этом проверяются сортировка и фильтр по редкости.
  for (let i = out.length; i < KIT_SIZE; i++) {
    const ilvl = ILVLS[i % ILVLS.length] ?? 1;
    // Редкость задаётся явно по кругу, а не катается: набор обязан
    // содержать ВСЕ редкости, иначе фильтр по редкой части проверять
    // нечем. Легендарки в круг не входят — их не выдают (см. drop).
    const rarity = ROTATION[i % ROTATION.length] ?? 'common';
    const item = generateItem(`kit:${exileNumber}:${i}`, { ilvl, rarity }, loot, ITEM_BASES);
    out.push({ ...item, container: 'stash' });
  }

  return out;
}

/** Редкости по кругу, кроме легендарной: её в M3a не выдают. */
const ROTATION: readonly Rarity[] = RARITIES.filter((rarity) => rarity !== 'legendary');
