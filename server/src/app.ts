import { API_ROUTES } from '@extramundum/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { createAuth } from './auth/index.ts';
import type { Config } from './config.ts';
import type { Database } from './db/client.ts';
import { notFound } from './http/errors.ts';
import { accessLog, errorHandler, requestContext, type AppEnv } from './http/middleware.ts';
import type { Logger } from './logger.ts';
import { authRoutes } from './routes/auth.ts';
import { battleRoutes } from './routes/battle.ts';
import { healthRoutes } from './routes/health.ts';
import { itemRoutes } from './routes/items.ts';
import { meRoutes } from './routes/me.ts';
import { runRoutes } from './routes/runs.ts';

export function createApp(db: Database, config: Config, log: Logger): Hono<AppEnv> {
  const auth = createAuth(db, config, log);
  const app = new Hono<AppEnv>();

  app.onError(errorHandler());
  app.use('*', requestContext(log));
  app.use('*', accessLog);
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });

  // credentials: true обязателен — сессия живёт в httpOnly-куке,
  // а клиент отдан со своего домена.
  app.use(
    '*',
    cors({
      origin: config.CORS_ORIGINS,
      credentials: true,
      allowHeaders: ['Content-Type', 'x-request-id'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
    }),
  );

  app.route('/', healthRoutes(db));
  app.route('/', meRoutes(db));
  app.route('/', battleRoutes(db));
  app.route('/', itemRoutes(db));
  app.route('/', runRoutes(db));
  app.route('/auth', authRoutes(db));

  // Вход, выход и чтение сессии обслуживает сам Better Auth.
  app.on(['GET', 'POST'], `${API_ROUTES.auth}/*`, (c) => c.get('auth').handler(c.req.raw));

  app.notFound(() => {
    throw notFound();
  });

  return app;
}
