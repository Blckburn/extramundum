import {
  API_ROUTES,
  apiErrorSchema,
  meResponseSchema,
  type ApiError,
  type DraftPickInput,
  type DraftResponse,
  type EquipInput,
  type InventoryResponse,
  type LockInput,
  type MoveInput,
  type RunExtractResponse,
  type RunFightResponse,
  type RunResponse,
  type RunStartInput,
  type SellInput,
  type SellResponse,
  type SimulatePreviewInput,
  type SimulatePreviewResponse,
  type UnequipInput,
  type ZonesResponse,
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
   * Забег с эвакуацией. GDD §7.2, §7.3.
   *
   * У боя, зелья и эвакуации ТЕЛА НЕТ. Чей забег — сервер знает
   * из сессии, какой бой следующий — из своей же базы. Прислать номер
   * боя значило бы дать клиенту выбрать, какой бой провести, то есть
   * переиграть смерть.
   *
   * ПОЧЕМУ ОТВЕТЫ НЕ РАЗБИРАЮТСЯ СХЕМОЙ ЦЕЛИКОМ. Формат лога описан
   * типами в `packages/shared/src/combat.ts` — типами, а не zod-схемой.
   * Написать здесь вторую, проверяющую, значило бы завести ВТОРОЙ
   * источник правды о формате: он разошёлся бы с первым на ближайшем
   * изменении, и разошёлся бы молча. Неизвестный тип события ловит
   * `schedule()` внятной ошибкой, а лог приходит от нашего же сервера,
   * который собрал его движком.
   */
  async zones(): Promise<ZonesResponse> {
    return (await request(API_ROUTES.zones)) as ZonesResponse;
  },

  async run(): Promise<RunResponse> {
    return (await request(API_ROUTES.run)) as RunResponse;
  },

  async startRun(input: RunStartInput): Promise<RunResponse> {
    return (await request(API_ROUTES.runStart, {
      method: 'POST',
      body: JSON.stringify(input),
    })) as RunResponse;
  },

  async runFight(): Promise<RunFightResponse> {
    return (await request(API_ROUTES.runFight, {
      method: 'POST',
      body: '{}',
    })) as RunFightResponse;
  },

  async runPotion(): Promise<RunResponse> {
    return (await request(API_ROUTES.runPotion, { method: 'POST', body: '{}' })) as RunResponse;
  },

  async runExtract(): Promise<RunExtractResponse> {
    return (await request(API_ROUTES.runExtract, {
      method: 'POST',
      body: '{}',
    })) as RunExtractResponse;
  },

  /**
   * Драфт уровня. GDD §5.2.
   *
   * В теле выбора — ОДИН идентификатор. Ни уровня, ни состава оффера
   * клиент не присылает: уровень сервер берёт из базы, оффер считает
   * сам и сверяет с присланным. Подделать выбор нечем.
   */
  async draft(): Promise<DraftResponse> {
    return (await request(API_ROUTES.draft)) as DraftResponse;
  },

  async pickDraft(input: DraftPickInput): Promise<DraftResponse> {
    return (await request(API_ROUTES.draftPick, {
      method: 'POST',
      body: JSON.stringify(input),
    })) as DraftResponse;
  },

  /**
   * Инвентарь, стеш и надетое. GDD §5.3, §6.3.
   *
   * Всё, что ниже, присылает серверу ТОЛЬКО идентификаторы. Ни одного
   * числа о предмете: состав и сила читаются сервером из БД, слот
   * выводится из базы предмета. Выдать себе предмет нечем — маршрута,
   * создающего предмет, в API нет вовсе (инвариант 1).
   */
  async items(): Promise<InventoryResponse> {
    return (await request(API_ROUTES.items)) as InventoryResponse;
  },

  async equip(input: EquipInput): Promise<void> {
    await request(API_ROUTES.itemsEquip, { method: 'POST', body: JSON.stringify(input) });
  },

  async unequip(input: UnequipInput): Promise<void> {
    await request(API_ROUTES.itemsUnequip, { method: 'POST', body: JSON.stringify(input) });
  },

  async moveItem(input: MoveInput): Promise<void> {
    await request(API_ROUTES.itemsMove, { method: 'POST', body: JSON.stringify(input) });
  },

  async lockItem(input: LockInput): Promise<void> {
    await request(API_ROUTES.itemsLock, { method: 'POST', body: JSON.stringify(input) });
  },

  async sellItems(input: SellInput): Promise<SellResponse> {
    return (await request(API_ROUTES.itemsSell, {
      method: 'POST',
      body: JSON.stringify(input),
    })) as SellResponse;
  },

  /**
   * Оценка шанса победы, при необходимости — «если надеть вот это».
   * Считает сервер: 300 прогонов Монте-Карло (GDD §6.4).
   */
  async preview(input: SimulatePreviewInput): Promise<SimulatePreviewResponse> {
    return (await request(API_ROUTES.simulatePreview, {
      method: 'POST',
      body: JSON.stringify(input),
    })) as SimulatePreviewResponse;
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
