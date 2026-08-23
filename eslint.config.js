import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/dist-render/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '.localdb/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // ─────────────────────────────────────────────────────────────────
  // Инвариант 2: packages/sim — чистая функция.
  // Ноль зависимостей, ноль I/O, никакого Math.random() и Date.now().
  // ─────────────────────────────────────────────────────────────────
  {
    files: ['packages/sim/**/*.ts'],
    ignores: ['packages/sim/**/__tests__/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'packages/sim не делает I/O (инвариант 2).' },
        { name: 'performance', message: 'packages/sim не обращается ко времени (инвариант 2).' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Источник случайности в sim — только сид из аргумента (инвариант 2).',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'packages/sim не обращается ко времени (инвариант 2).',
        },
      ],
      // Версия из typescript-eslint: она умеет отличать `import type`
      // от обычного импорта, а базовое правило — нет.
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'crypto'],
              message: 'packages/sim не делает I/O (инвариант 2).',
            },
            {
              // Типы контракта — единственное, что движок берёт снаружи,
              // и только через `import type`: такой импорт стирается при
              // компиляции, рантайм-ребра не возникает. Обычный импорт
              // отсюда по-прежнему запрещён.
              // Причина: docs/adr/0003-tipy-kontrakta-v-shared.md
              group: ['@extramundum/shared'],
              allowTypeImports: true,
              message:
                'Из @extramundum/shared в sim можно брать ТОЛЬКО типы: import type. ADR 0003.',
            },
            {
              // Всё остальное — рантайм-зависимость в любом виде.
              // Коэффициенты приходят аргументом, а не импортом (инвариант 5).
              group: ['@extramundum/data', '@extramundum/sim', '@extramundum/web'],
              message: 'packages/sim не зависит ни от чего, кроме типов контракта (инвариант 2).',
            },
          ],
        },
      ],
    },
  },

  // ─────────────────────────────────────────────────────────────────
  // Инвариант 3: движок не попадает в браузерный бандл.
  // Первая линия обороны — здесь, вторая — scripts/check-bundle.mjs.
  // ─────────────────────────────────────────────────────────────────
  {
    files: ['apps/web/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@extramundum/sim', '@extramundum/sim/*', '**/packages/sim/**'],
              message:
                'Инвариант 3: боевой движок живёт только на сервере. Превью — через POST /simulate/preview.',
            },
          ],
        },
      ],
    },
  },

  // Тесты: там нужны и node:fs, и обращения ко времени.
  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
    },
  },

  // probe-invariant-1.js исполняется в консоли браузера, а не в Node.
  // Глобальные объекты перечислены явно, а не заглушены no-undef: так
  // опечатка в имени всё ещё будет ошибкой.
  {
    files: ['scripts/probe-invariant-1.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
      },
    },
  },

  // Скрипты и конфиги сборки исполняются в Node.
  {
    files: ['scripts/**/*.mjs', '*.config.{js,ts}', '**/*.config.{js,ts}'],
    rules: {
      'no-undef': 'off',
    },
  },

  prettier,
);
