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

  /**
   * Проверка XML на коленке: в Node нет DOMParser, а тянуть
   * зависимость ради одного теста нельзя — стек зафиксирован.
   * Проверяется ровно то, чем ломается разбор в браузере.
   */
  function xmlErrors(text: string): string[] {
    const bad: string[] = [];

    /* ЗДЕСЬ сломалась версия 1: шапка документировала имена переменных
       палитры, а XML запрещает двойной дефис внутри комментария
       и дефис вплотную к закрывающей скобке. */
    for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) {
      const body = m[1] ?? '';
      if (body.includes('--')) bad.push(`двойной дефис в комментарии: ${body.slice(0, 40).trim()}`);
      if (body.endsWith('-')) bad.push(`дефис перед закрытием: ${body.slice(-40).trim()}`);
    }

    /* Парность тегов. Комментарии и объявления сняты: разметки
       внутри них нет. */
    const clean = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');
    const stack: string[] = [];
    for (const m of clean.matchAll(/<(\/?)([A-Za-z][\w:.-]*)([^>]*)>/g)) {
      const name = m[2] ?? '';
      if (m[1] === '/') {
        const open = stack.pop();
        if (open !== name) bad.push(`</${name}> закрывает <${open ?? 'ничего'}>`);
      } else if (!(m[3] ?? '').trimEnd().endsWith('/')) {
        stack.push(name);
      }
    }
    if (stack.length > 0) bad.push(`не закрыты: ${stack.join(', ')}`);

    /* Голый амперсанд — тоже отказ разбора, и внести его текстом
       в подпись символа проще всего. */
    for (const m of clean.matchAll(/&(?!#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][\w.-]*;)/g)) {
      bad.push(`голый амперсанд в позиции ${m.index}`);
    }
    return bad;
  }

  it('НАБОР ВАЛИДЕН КАК XML', () => {
    /* Первая версия набора им не была. Клиент разбирает спрайт строгим
       `image/svg+xml`, и на невалидном файле получал НОЛЬ символов —
       иконки исчезали молча, потому что DOMParser не бросает
       исключение, а возвращает документ с `parsererror` в корне.

       Тест стоит ровно там, где ломается: битый набор валит сборку,
       а не всплывает пустыми ячейками у игрока. */
    expect(xmlErrors(SPRITE), 'набор не разбирается как XML').toEqual([]);
  });

  it('проверка XML ловит поломку, а не молчит', () => {
    /* Пара к тесту выше. «Ошибок нет» проходит и тогда, когда проверка
       не умеет их находить, — а именно так и выглядела бы регрессия
       версии 1, снова прошедшая мимо. Диверсии повторяют её дословно
       и добавляют вторую форму поломки. */
    expect(xmlErrors(SPRITE.replace('<defs>', '<!-- var pal-bone -->\n<defs>'))).toEqual([]);
    expect(
      xmlErrors(SPRITE.replace('<defs>', '<!-- var --pal-bone -->\n<defs>')),
      'двойной дефис в комментарии не пойман',
    ).not.toEqual([]);
    expect(xmlErrors(SPRITE.replace('</defs>', '')), 'незакрытый тег не пойман').not.toEqual([]);
  });

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
