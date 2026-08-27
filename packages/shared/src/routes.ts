/**
 * Пути API в одном месте. Клиент не пишет строки URL руками —
 * иначе опечатка находится в рантайме, а не при компиляции.
 *
 * Это пути НА СЕРВЕРЕ. Клиент обращается к ним через префикс, заданный
 * VITE_API_URL: в проде это относительный `/api`, который статика
 * проксирует на сервер (см. render.yaml). Благодаря этому браузер видит
 * один сайт, и кука сессии остаётся первой стороной.
 */
export const API_ROUTES = {
  health: '/health',
  me: '/me',
  /** Better Auth: вход, выход, чтение сессии. */
  auth: '/auth',
  /** Собственная регистрация поверх Better Auth. */
  register: '/auth/register',
  simulatePreview: '/simulate/preview',

  /**
   * Забег с эвакуацией. GDD §7.2.
   *
   * У боя, зелья и эвакуации нет тела запроса: чей забег — из сессии,
   * какой бой следующий — из состояния в базе. Принимать номер боя
   * от клиента значило бы дать ему переиграть смерть.
   */
  zones: '/zones',
  run: '/run',
  runStart: '/run/start',
  runFight: '/run/fight',
  runPotion: '/run/potion',
  runExtract: '/run/extract',

  /** Инвентарь и экипировка. GDD §5.3, §6.3. */
  items: '/items',
  itemsEquip: '/items/equip',
  itemsUnequip: '/items/unequip',
  itemsMove: '/items/move',
  itemsLock: '/items/lock',
  itemsSell: '/items/sell',
} as const;

export type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];
