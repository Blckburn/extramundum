import {
  API_ROUTES,
  apiErrorSchema,
  meResponseSchema,
  type ApiError,
  type BattleStartInput,
  type BattleStartResponse,
  type MeResponse,
  type SignInInput,
  type SignUpInput,
} from '@extramundum/shared';

/**
 * Типизированный клиент API.
 *
 * Чего здесь принципиально НЕТ и не будет: строки подключения к БД,
 * SQL, боевого движка. Клиент умеет ровно одно — сходить по HTTP
 * и разобрать ответ. Всё, что меняет состояние игрока, решает сервер
 * (инвариант 1).
 */
/**
 * Префикс всех запросов к API.
 *
 * По умолчанию ОТНОСИТЕЛЬНЫЙ `/api` — то есть тот же origin, что и сам
 * клиент. Это принципиально: сессия живёт в куке, а кука с чужого домена
 * является сторонней, и браузеры режут такие всё активнее. Через
 * относительный путь запрос идёт на домен клиента, статика проксирует
 * его на сервер (render.yaml), и кука становится первой стороной.
 *
 * Абсолютный URL можно задать через VITE_API_URL — но тогда возвращается
 * ровно та проблема со сторонней кукой, ради которой всё это сделано.
 */
const BASE_URL: string = import.meta.env['VITE_API_URL'] ?? '/api';

/** Ошибка, у которой есть ключ локали. Именно её показывает UI. */
export class ApiClientError extends Error {
  readonly messageKey: string;
  readonly fields: Record<string, string>;
  readonly status: number;

  constructor(messageKey: string, status: number, fields: Record<string, string> = {}) {
    super(messageKey);
    this.name = 'ApiClientError';
    this.messageKey = messageKey;
    this.status = status;
    this.fields = fields;
  }
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;

  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      // Сессия живёт в httpOnly-куке: без credentials её не отправить.
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
  } catch {
    throw new ApiClientError('error.network', 0);
  }

  const text = await response.text();
  const body: unknown = text === '' ? null : JSON.parse(text);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      const { error }: ApiError = parsed.data;
      throw new ApiClientError(error.messageKey, response.status, error.fields ?? {});
    }
    // Ответ не в нашем конверте — например, ошибка самого Better Auth.
    throw new ApiClientError('error.internal', response.status);
  }

  return body;
}

export const api = {
  async register(input: SignUpInput): Promise<void> {
    await request(API_ROUTES.register, { method: 'POST', body: JSON.stringify(input) });
  },

  async signIn(input: SignInInput): Promise<void> {
    await request(`${API_ROUTES.auth}/sign-in/email`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async signOut(): Promise<void> {
    await request(`${API_ROUTES.auth}/sign-out`, { method: 'POST', body: '{}' });
  },

  /**
   * Провести бой. GDD §3.2.
   *
   * В теле нет ни одного числа о бойце, и схема таких полей не содержит:
   * состав читается сервером из БД по проверенной сессии. Клиент
   * получает готовый лог и не может ни на что в нём повлиять.
   *
   * ПОЧЕМУ ОТВЕТ НЕ РАЗБИРАЕТСЯ СХЕМОЙ ЦЕЛИКОМ. Формат лога описан
   * типами в `packages/shared/src/combat.ts` — типами, а не zod-схемой.
   * Написать здесь вторую, проверяющую, значило бы завести ВТОРОЙ
   * источник правды о формате: он разошёлся бы с первым на ближайшем
   * изменении, и разошёлся бы молча. Неизвестный тип события ловит
   * `schedule()` внятной ошибкой, а лог приходит от нашего же сервера,
   * который собрал его движком.
   */
  async startBattle(input: BattleStartInput): Promise<BattleStartResponse> {
    const body = await request(API_ROUTES.battleStart, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return body as BattleStartResponse;
  },

  /** Профиль текущего игрока. null — сессии нет. */
  async me(): Promise<MeResponse | null> {
    try {
      return meResponseSchema.parse(await request(API_ROUTES.me));
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) return null;
      throw err;
    }
  },
};
