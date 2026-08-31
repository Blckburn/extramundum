import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ICON_ENTITIES, expectedIconKeys, iconPath, icons, symbols } from '../assets.ts';

/**
 * ART-BIBLE §7: «Тест в CI проходит по всем сущностям и падает, если
 * у чего-то нет иконки или файл отсутствует на диске. Это переводит
 * "не забыли нарисовать" из области памяти в область красной сборки».
 *
 * Здесь же проверяется второе требование того же раздела: игра должна
 * собираться и запускаться с нулём готовых иконок.
 */

/** Куда process-assets.mjs кладёт готовые файлы. */
const PUBLIC_ASSETS = fileURLToPath(new URL('../../../apps/web/public/assets/', import.meta.url));

const MAX_ICON_BYTES = 20 * 1024; // ART-BIBLE §6

describe('манифест иконок', () => {
  it('у каждой сущности есть запись', () => {
    const missing = expectedIconKeys().filter((key) => !(key in icons));

    expect(
      missing,
      `Про эти сущности забыли: добавьте их в packages/data/assets.json ` +
        `со значением null, если иконка ещё не нарисована.`,
    ).toEqual([]);
  });

  it('в манифесте нет записей о несуществующих сущностях', () => {
    const expected = new Set(expectedIconKeys());
    const orphans = Object.keys(icons).filter((key) => !expected.has(key));

    expect(orphans, 'Эти ключи ни к чему не относятся — сущность удалили, запись осталась').toEqual(
      [],
    );
  });

  it('каждый заявленный путь существует на диске', () => {
    const broken: string[] = [];

    for (const [key, path] of Object.entries(icons)) {
      // null — это «ещё не нарисовано», а не поломка.
      if (path === null) continue;
      if (!existsSync(PUBLIC_ASSETS + path)) broken.push(`${key} -> ${path}`);
    }

    expect(broken, 'Путь заявлен, а файла нет. Либо положите файл, либо верните null.').toEqual([]);
  });

  it('готовые иконки укладываются в 20 КБ', () => {
    const heavy: string[] = [];

    for (const [key, path] of Object.entries(icons)) {
      if (path === null) continue;
      const full = PUBLIC_ASSETS + path;
      if (!existsSync(full)) continue; // ловится предыдущим тестом
      const { size } = statSync(full);
      if (size > MAX_ICON_BYTES) heavy.push(`${key}: ${Math.round(size / 1024)} КБ`);
    }

    expect(heavy, 'ART-BIBLE §6: иконка тяжелее 20 КБ').toEqual([]);
  });

  it('пути ведут в WebP и в kebab-case латиницей', () => {
    const wrong: string[] = [];

    for (const [key, path] of Object.entries(icons)) {
      if (path === null) continue;
      if (!path.endsWith('.webp')) wrong.push(`${key}: не .webp`);
      if (!/^[a-z0-9/-]+\.webp$/.test(path)) wrong.push(`${key}: только kebab-case и латиница`);
      if (path.startsWith('/') || path.includes('..'))
        wrong.push(`${key}: путь должен быть относительным`);
    }

    expect(wrong, 'ART-BIBLE §6, именование').toEqual([]);
  });

  it('игра собирается при нуле готовых иконок', () => {
    // Ключевое требование ART-BIBLE §7. Отсутствие иконки не должно быть
    // ошибкой — на её месте рисуется плейсхолдер.
    for (const key of expectedIconKeys()) {
      expect(() => iconPath(key)).not.toThrow();
    }

    // Неизвестный ключ тоже не роняет: UI покажет плейсхолдер.
    expect(iconPath('weapon.которого-нет')).toBeNull();
  });

  it('категории не пересекаются и не пусты', () => {
    const seen = new Set<string>();
    for (const [category, ids] of Object.entries(ICON_ENTITIES)) {
      expect(ids.length, `категория ${category} пуста`).toBeGreaterThan(0);
      for (const id of ids) {
        const key = `${category}.${id}`;
        expect(seen.has(key), `дубль ключа ${key}`).toBe(false);
        seen.add(key);
      }
    }
  });
});

describe('векторные силуэты', () => {
  const SPRITE = readFileSync(
    fileURLToPath(
      new URL('../../../apps/web/public/assets/icons-placeholder.svg', import.meta.url),
    ),
    'utf8',
  );
  const ids = new Set([...SPRITE.matchAll(/<symbol\s+id="([^"]+)"/g)].map((m) => m[1] ?? ''));

  it('каждый назначенный символ существует в наборе', () => {
    expect(ids.size, 'символы в наборе не нашлись — проверка ниже пуста').toBeGreaterThan(0);
    for (const [key, id] of Object.entries(symbols)) {
      expect(ids.has(id), `${key} ссылается на несуществующий символ ${id}`).toBe(true);
    }
  });

  it('каждый ключ символа — существующая сущность', () => {
    /* Иначе набор обрастает записями для того, чего в игре нет,
       и никто не замечает: лишний ключ ничего не ломает. */
    const known = new Set(expectedIconKeys());
    for (const key of Object.keys(symbols)) {
      expect(known.has(key), `символ назначен несуществующей сущности ${key}`).toBe(true);
    }
  });

  it('все десять статусов имеют свой силуэт, и все разные', () => {
    /* Статусы висят над бойцом в 24 пикселя — самое жёсткое место
       по читаемости. Общий силуэт на два статуса там означает, что
       игрок не отличит яд от ожога. */
    const status = Object.entries(symbols).filter(([key]) => key.startsWith('status.'));
    expect(status).toHaveLength(10);
    expect(new Set(status.map(([, id]) => id)).size).toBe(10);
  });

  it('КВАДРАТ С БУКВОЙ ОСТАЁТСЯ ЗАПАСНЫМ, а не убран', () => {
    /* ART-BIBLE §7: игра обязана собираться при нуле готовых файлов.
       Силуэты — второй уровень плейсхолдера, а не замена первому:
       у зон, трейтов и архетипов силуэтов нет, и им нужен квадрат. */
    const withoutSymbol = expectedIconKeys().filter((key) => symbols[key] === undefined);
    expect(
      withoutSymbol.length,
      'силуэты есть у всего — запасной путь стал мёртвым кодом',
    ).toBeGreaterThan(0);
    expect(withoutSymbol.some((key) => key.startsWith('trait.'))).toBe(true);
  });
});
