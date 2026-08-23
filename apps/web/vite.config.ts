import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

/**
 * Инвариант 3: @extramundum/sim не попадает в браузерный бандл.
 *
 * Здесь стоит третий рубеж защиты (первый — правило ESLint, второй —
 * отсутствие sim в зависимостях apps/web): если движок всё-таки окажется
 * в графе импортов, сборка падает прямо здесь, с внятным сообщением.
 * Четвёртый рубеж — scripts/check-bundle.mjs, который смотрит уже
 * на собранные файлы.
 */
function forbidSimImport() {
  return {
    name: 'extramundum:forbid-sim-import',
    resolveId(source: string, importer: string | undefined) {
      if (source === '@extramundum/sim' || source.startsWith('@extramundum/sim/')) {
        throw new Error(
          `Инвариант 3 нарушен: ${importer ?? 'клиент'} импортирует ${source}.\n` +
            'Боевой движок исполняется только на сервере (GDD §3.1).\n' +
            'Превью шансов победы получают эндпоинтом POST /simulate/preview.',
        );
      }
      return null;
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [forbidSimImport()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        /**
         * three.js — отдельным чанком.
         *
         * Не ради кэширования, а ради ИЗМЕРИМОСТИ: бюджет GDD §3.4
         * записан как «бандл (gzip, без three.js) < 400 КБ». Пока движок
         * рендера лежит в общем файле, эту величину нельзя ни посчитать,
         * ни проверить — а бюджет без проверки это комментарий.
         *
         * Побочная польза настоящая: three меняется раз в квартал,
         * наш код — каждый день, и общий чанк заставлял бы игрока
         * перекачивать полмегабайта ради правки в подписи кнопки.
         */
        manualChunks(id) {
          if (id.includes('/node_modules/three/')) return 'three';
          return null;
        },
      },
    },
  },
  server: {
    port: 5173,
    // В разработке клиент и сервер тоже на разных портах, а значит на
    // разных origin. Прокси делает их одним сайтом — ровно так же, как
    // в проде это делает статика Render. Иначе локально мы проверяли бы
    // не то, что работает у игрока.
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
