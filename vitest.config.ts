import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import SkipGuard from './scripts/vitest-skip-guard.ts';

export default defineConfig({
  resolve: {
    alias: {
      /**
       * В тестах `@extramundum/data` — это ИСХОДНИКИ, а не dist.
       *
       * `tsc` копирует json в `dist/`, и без этого алиаса тест читает
       * копию: правка balance.json или спецификации рига не доходит
       * до проверки, пока кто-нибудь не пересоберёт пакет. В CI это
       * скрыто тем, что `typecheck` идёт перед `test` и собирает dist,
       * — то есть ловушка ждёт того, кто запустит `vitest` локально
       * и увидит зелёное на устаревших данных.
       *
       * Поймано диверсией: правка спецификации рига не роняла тест,
       * который на неё и написан.
       */
      '@extramundum/data': fileURLToPath(new URL('./packages/data/index.ts', import.meta.url)),
    },
  },
  test: {
    /**
     * Страж пропусков. Перечисляет пропущенные тесты поимённо, а при
     * CI=true валит прогон: способа увидеть зелёное на непройденных
     * тестах существовать не должно. Подробности — в самом файле.
     */
    reporters: ['default', new SkipGuard()],

    // Один прогон на весь монорепо: pnpm test.
    include: ['{packages,apps,server,scripts}/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
});
