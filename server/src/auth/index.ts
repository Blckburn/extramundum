import { API_ROUTES, PASSWORD_MAX, PASSWORD_MIN } from '@extramundum/shared';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import type { Config } from '../config.ts';
import type { Database } from '../db/client.ts';
import { schema } from '../db/client.ts';
import { grantItems } from '../items/repository.ts';
import { startingKit } from '../items/starting-kit.ts';
import { ensurePlayer } from '../players/repository.ts';
import type { Logger } from '../logger.ts';

export type Auth = ReturnType<typeof createAuth>;

/**
 * Better Auth владеет идентичностью: учётной записью, паролем и сессией.
 * Игровой профиль он не трогает — тот живёт в players и создаётся хуком ниже.
 */
export function createAuth(db: Database, config: Config, log: Logger) {
  return betterAuth({
    appName: 'extramundum',
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,
    basePath: API_ROUTES.auth,
    trustedOrigins: config.CORS_ORIGINS,

    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      // Почту не подтверждаем: почтовый провайдер в стек M0 не входит.
      requireEmailVerification: false,
    },

    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },

    advanced: {
      // SameSite=Lax, а не None: клиент обращается к API по относительному
      // пути на своём же домене (статика проксирует запрос на сервер),
      // поэтому кука первой стороны. SameSite=None понадобился бы только
      // при обращении на чужой домен — и тогда браузер вправе её выбросить.
      defaultCookieAttributes:
        config.NODE_ENV === 'production'
          ? { sameSite: 'lax', secure: true, httpOnly: true }
          : { sameSite: 'lax', secure: false, httpOnly: true },
    },

    databaseHooks: {
      user: {
        create: {
          async after(createdUser) {
            // Профиль создаётся сразу после учётной записи. Если этот хук
            // не отработает (падение процесса между двумя записями),
            // профиль будет достроен лениво при первом GET /me —
            // ensurePlayer идемпотентен. Двух источников правды не возникает:
            // уникальность players.user_id гарантирует ровно одну строку.
            const { created, player } = await ensurePlayer(db, {
              userId: createdUser.id,
              username: createdUser.name,
            });
            log.info('игровой профиль создан', { userId: createdUser.id });

            /* Набор предметов для проверки интерфейса — ТОЛЬКО за флагом.
               По умолчанию новый аккаунт не получает ничего: изгнанного
               вывели за стену ни с чем (LORE §2), а источник лута —
               рейды из M3b. Без предметов, однако, нечем проверить
               ни фильтры, ни сортировку, ни массовую продажу. */
            if (config.DEV_STARTING_KIT && created && player !== null) {
              await grantItems(db, player.id, startingKit(player.exileNumber));
              log.warn('выдан набор разработки', {
                playerId: player.id,
                note: 'DEV_STARTING_KIT=true — в проде такого быть не должно',
              });
            }
          },
        },
      },
    },
  });
}
