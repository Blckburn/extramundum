/**
 * @extramundum/data — контент как данные.
 *
 * Инвариант 5: числа баланса живут в balance.json, а не в коде.
 * Логика читает их отсюда и не содержит собственных констант.
 *
 * В M0 здесь только баланс. Оружие, броня, аффиксы, монстры и зоны
 * добавляются начиная с M1 (GDD §11).
 */
import balanceJson from './balance.json' with { type: 'json' };

export const balance = balanceJson;
export type Balance = typeof balanceJson;

export * from './assets.ts';
export * from './render.ts';
