/**
 * Метка сборки клиента.
 *
 * `__BUILD_TAG__` подставляет vite при сборке (см. `vite.config.ts`).
 * Объявление здесь — единственное место, где о ней знает TypeScript:
 * без него `define` работал бы, а компилятор ругался.
 *
 * Значение по умолчанию нужно тестам и dev-страницам, которые собирает
 * не vite: без него они падали бы на неопределённом идентификаторе.
 */
declare const __BUILD_TAG__: string | undefined;

export function buildTag(): string {
  return typeof __BUILD_TAG__ === 'string' ? __BUILD_TAG__ : 'dev';
}
