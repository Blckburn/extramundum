import { balance as balanceData } from '@extramundum/data';
import {
  economyBalanceSchema,
  lootBalanceSchema,
  sellPrice,
  type EconomyBalance,
  type Item,
} from '@extramundum/shared';

/**
 * Коэффициенты экономики и цены. GDD §6.3.
 *
 * ОТДЕЛЬНЫМ МОДУЛЕМ И БЕЗ ЕДИНОГО ОБРАЩЕНИЯ К БАЗЕ. Цену читают и показ
 * предмета, и продажа, и лавка; будь она в модуле доступа к БД, чистая
 * сборка показа зависела бы от него без всякой нужды.
 *
 * ФОРМУЛЫ ЖИВУТ В `shared` — здесь только подстановка коэффициентов.
 * Вторая реализация разошлась бы с прибором экономики молча, и он
 * выверял бы цены, которых игрок не платит. Одна функция на репозиторий,
 * как `enemyLevel` и `seededRoll`.
 */

const loot = lootBalanceSchema.parse(balanceData.items);

export const economy: EconomyBalance = economyBalanceSchema.parse(balanceData.economy);

/** Цена продажи предмета. */
export function priceOf(item: Pick<Item, 'ilvl' | 'rarity' | 'affixes'>): number {
  return sellPrice(item, { ...loot.sell, ilvlScale: loot.ilvlScale });
}
