import { z } from 'zod';

/**
 * Конфигурация сервера. Читается из переменных окружения один раз при
 * старте и валидируется. Если чего-то не хватает — процесс падает сразу
 * с понятным сообщением, а не через час в первом запросе к БД.
 *
 * Инвариант 7: значения приходят из окружения, в репозитории их нет.
 */
/**
 * Допустимые имена принятых исключений.
 *
 * `migration-journal` — журнал миграций доступен роли рантайма на запись.
 * На Neon роль из консоли приходит с атрибутом BYPASSRLS, поэтому
 * построчная защита журнала не действует, а снять атрибут нельзя:
 * управление ролями вынесено в панель. Причина и замеры — ADR 0002.
 */
export const PRIVILEGE_EXCEPTIONS = ['migration-journal'] as const;
export type PrivilegeException = (typeof PRIVILEGE_EXCEPTIONS)[number];

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),

  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET должен быть не короче 32 символов'),
  /**
   * Адрес, по которому Better Auth сопоставляет входящие запросы:
   * baseURL + basePath должны равняться пути, который ВИДИТ СЕРВЕР.
   *
   * Только origin, без пути. Причина не в аккуратности: статика снимает
   * префикс `/api` при проксировании, и до сервера доходит `/auth/...`.
   * Если сюда записать адрес клиента вместе с `/api`, Better Auth станет
   * ждать `/api/auth/...`, не найдёт совпадения и ответит 404 на вход —
   * молча, потому что 404 не ошибка. Ровно это и случилось на проде.
   */
  BETTER_AUTH_URL: z.url().refine(
    (v) => {
      const { pathname } = new URL(v);
      return pathname === '/' || pathname === '';
    },
    {
      message:
        'BETTER_AUTH_URL должен быть только origin, без пути: сервер получает запросы на /auth, а не на /api/auth',
    },
  ),

  /**
   * Известные и осознанно принятые ограничения прав роли БД. Через запятую.
   *
   * Зачем это вообще есть. Проверка прав при старте (`src/db/privileges.ts`)
   * стоит ровно на одном: ей верят. Верное предупреждение, которое висит
   * в логах каждый старт и починить которое нельзя, через неделю читается
   * как фон — и тогда оно промолчит в тот день, когда скажет о новом.
   *
   * Поэтому известный риск объявляется здесь явным решением человека
   * и перестаёт логироваться. Неизвестный по-прежнему кричит.
   *
   * Набор имён закрыт: опечатка валит старт, а не возвращает тот самый
   * шум, ради устранения которого механизм и заведён.
   */
  DB_PRIVILEGE_EXCEPTIONS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(PRIVILEGE_EXCEPTIONS)))
    .transform((v) => [...new Set(v)]),

  /**
   * Выдавать ли новым аккаунтам набор предметов для проверки интерфейса.
   *
   * ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНО, и это не осторожность, а лор: изгнанного
   * вывели за стену ни с чем (LORE §2), и стартовый комплект спорил бы
   * и с этим, и с прогрессией. Но без предметов нечем проверить ни
   * фильтры, ни сортировку, ни массовую продажу — поэтому флаг есть,
   * а умолчание пустое.
   *
   * Источник лута в игре появится в M3b вместе с рейдами.
   */
  DEV_STARTING_KIT: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  /** Через запятую. Origin-ы клиента, которым разрешены запросы с куками. */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(корень)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Не удалось прочитать конфигурацию из переменных окружения:\n${details}\n\n` +
        `Смотри .env.example — там перечислено всё, что нужно.`,
    );
  }

  const config = parsed.data;

  // Строка подключения к Neon обязана быть pooled (ADR 0001). Прямое
  // соединение исчерпывает лимит подключений при первом же всплеске.
  if (config.NODE_ENV === 'production' && config.DATABASE_URL.includes('neon.tech')) {
    if (!config.DATABASE_URL.includes('-pooler.')) {
      throw new Error(
        'DATABASE_URL указывает на Neon без пулера. Нужна pooled-строка ' +
          '(в хосте есть "-pooler"), см. docs/adr/0001-stack.md.',
      );
    }
  }

  return config;
}
