/**
 * @extramundum/data — контент как данные.
 *
 * Инвариант 5: числа баланса живут в balance.json, а не в коде.
 * Логика читает их отсюда и не содержит собственных констант.
 *
 * Здесь: баланс, манифест иконок, палитра и риги (M2a), анимации
 * воспроизведения (M2b), базы предметов (M3a). Монстры и зоны — M3b.
 */
import balanceJson from './balance.json' with { type: 'json' };

export const balance = balanceJson;
export type Balance = typeof balanceJson;

export * from './assets.ts';
export * from './items.ts';
export * from './render.ts';
