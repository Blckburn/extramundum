import { describe, expect, it } from 'vitest';

import ru from '../../../../locales/ru.json' with { type: 'json' };

/**
 * Склонение числительных. Проверяется НАСТОЯЩАЯ функция интерфейса,
 * а не её копия: «1 предметов» на кнопке решения — то, что игрок
 * увидел в живой сессии, и ловить это должен тест, а не глаз.
 *
 * `i18n.ts` при загрузке спрашивает язык у браузера, а тесты идут
 * в окружении `node`. Поэтому здесь заведены ровно те два объекта,
 * которых модулю не хватает, — и заведены ДО импорта, иначе он упадёт
 * на первой же строке.
 */
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  },
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { language: 'ru-RU' },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { documentElement: { lang: 'ru' } },
});

const { plural, setLocale } = await import('../i18n.ts');

describe('склонение числительных', () => {
  it('русские формы: одна, малая, множественная', () => {
    setLocale('ru');
    expect(plural(1, 'unit.items')).toBe('1 предмет');
    expect(plural(2, 'unit.items')).toBe('2 предмета');
    expect(plural(5, 'unit.items')).toBe('5 предметов');
    expect(plural(0, 'unit.items')).toBe('0 предметов');
  });

  it('подростковые числа идут во множественную форму, а не в свою по последней цифре', () => {
    setLocale('ru');
    // 11, 12, 14 кончаются на 1, 2 и 4 — правило по последней цифре
    // дало бы «11 предмет», и ровно это в интерфейсах и встречается.
    expect(plural(11, 'unit.items')).toBe('11 предметов');
    expect(plural(12, 'unit.items')).toBe('12 предметов');
    expect(plural(14, 'unit.items')).toBe('14 предметов');
    // А 21, 22, 24 — своими формами, иначе проверка выше проходила бы
    // и на функции, которая всегда возвращает множественную.
    expect(plural(21, 'unit.items')).toBe('21 предмет');
    expect(plural(22, 'unit.items')).toBe('22 предмета');
    expect(plural(24, 'unit.items')).toBe('24 предмета');
  });

  it('английский обходится двумя формами', () => {
    setLocale('en');
    expect(plural(1, 'unit.items')).toBe('1 item');
    expect(plural(2, 'unit.items')).toBe('2 items');
    expect(plural(5, 'unit.items')).toBe('5 items');
  });

  it('у каждой формы есть строка в словаре', () => {
    for (const form of ['one', 'few', 'many']) {
      expect(Object.keys(ru)).toContain(`unit.items.${form}`);
    }
  });
});
