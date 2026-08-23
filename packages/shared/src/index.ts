/**
 * @extramundum/shared — контракт между клиентом и сервером.
 *
 * Здесь живут zod-схемы, которыми сервер валидирует ВЕСЬ входящий трафик,
 * и типы, которыми клиент типизирует ответы. Одно определение на обе
 * стороны: если контракт меняется, обе стороны перестают компилироваться.
 *
 * Чего здесь нет и не будет: обращений к БД, к сети и к боевому движку.
 */
export * from './auth.js';
export * from './battle.js';
export * from './combat.js';
export * from './errors.js';
export * from './player.js';
export * from './render.js';
export * from './routes.js';
export * from './validation.js';
