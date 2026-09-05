import {
  ALL_TRAIT_IDS,
  ARMOR_CLASSES,
  WEAPON_CLASSES,
  ZONE_IDS,
  enemyLevel,
  isSegmentUnlocked,
  segmentBounds,
} from '@extramundum/shared';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { balance, FIGHTER_RIG_IDS, palette, RIGS } from '../index.ts';
import { MONSTERS, ZONES, monsterSpec, zoneSpec } from '../zones.ts';

/**
 * Зоны и монстры. GDD §7.4, §7.5.
 *
 * Проверяется СОГЛАСОВАННОСТЬ данных, а не баланс: баланс меряет
 * матрица. Каждая проверка ниже стоит на месте конкретного способа
 * разойтись молча — зона со ссылкой на несуществующего монстра, монстр
 * с ригом без узлов-привязок, перекраска в цвет мимо палитры, класс
 * брони в плашке, не совпадающий с тем, кто в зоне на самом деле.
 */

const ru = JSON.parse(
  readFileSync(new URL('../../../locales/ru.json', import.meta.url), 'utf8'),
) as Record<string, string>;

/** Узлы-привязки из animations.stage: без них рендер бойца падает. */
const REQUIRED_NODES = ['head', 'torso'];

describe('зоны', () => {
  it('пять играбельных зон, Разлома среди них нет', () => {
    // Зона без монстров хуже отсутствующей: выглядит как реализованная.
    expect(ZONES).toHaveLength(5);
    expect(ZONES.map((z) => z.id)).not.toContain('rift');
    expect(zoneSpec('rift')).toBeUndefined();
  });

  it('каждая зона объявлена в перечислении и имеет название', () => {
    for (const zone of ZONES) {
      expect(ZONE_IDS).toContain(zone.id);
      expect(ru[`zone.${zone.id}`], `нет названия зоны «${zone.id}»`).toBeTruthy();
    }
  });

  it('диапазоны уровней идут по возрастанию и стыкуются', () => {
    /* Разрыв между зонами означал бы уровни, на которых игроку некуда
       идти; перехлёст в обратную сторону — что вторая зона легче первой.
       GDD §7.4 задаёт стык: 1–8, 8–16, 16–24, 24–32, 32–40. */
    let previousMax = 0;
    for (const zone of ZONES) {
      const [min, max] = zone.levels;
      expect(max, `зона «${zone.id}»`).toBeGreaterThan(min);
      if (previousMax > 0) expect(min, `разрыв перед зоной «${zone.id}»`).toBe(previousMax);
      previousMax = max;
    }
    expect(previousMax).toBe(balance.progression.levelCap);
  });

  it('ссылки на монстров и босса разрешаются', () => {
    for (const zone of ZONES) {
      for (const key of zone.monsters) expect(() => monsterSpec(key)).not.toThrow();
      expect(() => monsterSpec(zone.boss)).not.toThrow();
      expect(monsterSpec(zone.boss).boss, `«${zone.boss}» не помечен боссом`).toBe(true);
    }
  });

  it('обычные монстры зоны НЕ помечены боссами', () => {
    // Иначе пятый бой перестал бы отличаться от остальных, а §7.5
    // держится ровно на том, что босс один и он последний.
    for (const zone of ZONES) {
      for (const key of zone.monsters) expect(monsterSpec(key).boss, key).toBe(false);
    }
  });

  it('класс брони зоны совпадает с большинством её пула', () => {
    /* Класс из зоны показывается игроку плашкой матчапа (§4.3),
       и это РАБОЧИЙ рычаг: по нему выбирают оружие. Разойдись он
       с настоящим составом — плашка врала бы, а игрок переоделся
       бы не под тех. */
    for (const zone of ZONES) {
      const classes = zone.monsters.map((key) => monsterSpec(key).armorClass);

      if (zone.armorClass === 'mixed') {
        // «Смешанные» обязано быть правдой и в другую сторону: зона
        // из трёх одинаковых врагов, названная смешанной, врёт так же.
        expect(new Set(classes).size, `зона «${zone.id}» названа смешанной`).toBeGreaterThan(1);
        continue;
      }

      const matching = classes.filter((c) => c === zone.armorClass).length;
      expect(
        matching * 2,
        `зона «${zone.id}»: заявлена «${zone.armorClass}», в пуле ${classes.join(', ')}`,
      ).toBeGreaterThanOrEqual(classes.length);
    }
  });

  it('зоны РАЗЛИЧАЮТСЯ классом брони — иначе матчапы не работают', () => {
    // Если все зоны одного класса, переодеваться перед зоной незачем,
    // и вся таблица §4.3 становится украшением.
    const distinct = new Set(ZONES.map((z) => z.armorClass));
    expect(distinct.size).toBeGreaterThanOrEqual(3);
  });
});

describe('участки', () => {
  it('у каждой зоны ровно четыре участка, и они покрывают её диапазон', () => {
    for (const zone of ZONES) {
      expect(zone.segments, zone.id).toHaveLength(4);
      expect(zone.segments[0]?.levels[0], `${zone.id}: первый участок не с начала зоны`).toBe(
        zone.levels[0],
      );
      expect(zone.segments[3]?.levels[1], `${zone.id}: последний участок не до конца зоны`).toBe(
        zone.levels[1],
      );
    }
  });

  it('участки идут по возрастанию и не оставляют дыр', () => {
    /* Дыра означала бы уровень, недоступный ни на одном участке,
       то есть ilvl, за которым некуда идти. Пересечение на границе
       (8-10, 10-12) — не дыра и допустимо: у Пустошей участки
       не пересекаются, у остальных зон делят границу, и это данные,
       а не формула. */
    for (const zone of ZONES) {
      for (let i = 0; i < zone.segments.length; i++) {
        const [lo, hi] = zone.segments[i]?.levels ?? [0, 0];
        expect(lo, `${zone.id}#${i}`).toBeLessThanOrEqual(hi);
        const previous = zone.segments[i - 1];
        if (previous === undefined) continue;
        expect(lo, `${zone.id}#${i}: участок начинается раньше предыдущего`).toBeGreaterThanOrEqual(
          previous.levels[0],
        );
        expect(lo, `${zone.id}#${i}: между участками дыра`).toBeLessThanOrEqual(
          previous.levels[1] + 1,
        );
      }
    }
  });

  it('МНОЖИТЕЛЬ СИЛЫ ЖИВЁТ У УЧАСТКА, и второго у зоны нет', () => {
    /* Две копии одной величины — это место, где они разойдутся.
       Множитель переехал с зоны на участок после замера лестницы:
       с одним числом на зону трудность внутри неё шла не туда. */
    for (const zone of ZONES) {
      for (const [i, segment] of zone.segments.entries()) {
        expect(segment.power, `${zone.id}#${i}`).toBeGreaterThan(0);
      }
      expect(
        (zone as unknown as Record<string, unknown>).power,
        `${zone.id}: у зоны остался свой множитель`,
      ).toBeUndefined();
    }
  });

  it('УРОВЕНЬ ВРАГА НЕ ЗАВИСИТ ОТ ИГРОКА — подпись это гарантирует', () => {
    /* Проверка на класс ошибки, а не на значение: прежняя формула
       принимала уровень игрока аргументом, и вернуть её значило бы
       вернуть тупик. Аргументов у `enemyLevel` четыре, и уровня игрока
       среди них нет — это видно по числу параметров. */
    expect(enemyLevel.length).toBe(4);
  });

  it('уровень разыгрывается ВНУТРИ участка, а босс берёт верхнюю границу', () => {
    const wastes = ZONES[0];
    if (wastes === undefined) throw new Error('нет первой зоны');

    for (let segment = 0; segment < 4; segment++) {
      const [lo, hi] = wastes.segments[segment]?.levels ?? [0, 0];
      const seen = new Set<number>();
      for (let i = 0; i < 200; i++) {
        const level = enemyLevel(wastes, segment, i / 200, false);
        expect(level).toBeGreaterThanOrEqual(lo);
        expect(level).toBeLessThanOrEqual(hi);
        seen.add(level);
      }
      /* Пара к проверке диапазона: «в границах» верно и для броска,
         который всегда даёт одно и то же. Участок обязан ронять ВСЕ
         свои уровни, иначе ilvl 1 не существовал бы вовсе. */
      expect(seen.size, `участок ${segment} выдал один уровень`).toBe(hi - lo + 1);

      // Босс — последний бой участка, слабее рядового ему быть не с чего.
      expect(enemyLevel(wastes, segment, 0, true)).toBe(hi);
      expect(enemyLevel(wastes, segment, 0.999, true)).toBe(hi);
    }
  });

  it('крайние броски не выходят за участок', () => {
    const wastes = ZONES[0];
    if (wastes === undefined) throw new Error('нет первой зоны');
    const [lo, hi] = wastes.segments[3]?.levels ?? [0, 0];
    expect(enemyLevel(wastes, 3, 0, false)).toBe(lo);
    expect(enemyLevel(wastes, 3, 1, false)).toBe(hi);
    // Бросок вне [0,1) не должен пробивать границу ни в какую сторону.
    expect(enemyLevel(wastes, 3, -5, false)).toBe(lo);
    expect(enemyLevel(wastes, 3, 5, false)).toBe(hi);
  });

  it('несуществующий участок — отказ, а не тихий первый', () => {
    const wastes = ZONES[0];
    if (wastes === undefined) throw new Error('нет первой зоны');
    expect(() => segmentBounds(wastes, 4)).toThrow();
    expect(() => segmentBounds(wastes, -1)).toThrow();
  });
});

describe('отпирание участков', () => {
  const first = ZONES[0]?.id ?? '';
  const second = ZONES[1]?.id ?? '';

  it('первый участок первой зоны открыт всегда', () => {
    expect(isSegmentUnlocked(ZONES, {}, first, 0)).toBe(true);
    // И только он: без прохождения дальше хода нет.
    expect(isSegmentUnlocked(ZONES, {}, first, 1)).toBe(false);
    expect(isSegmentUnlocked(ZONES, {}, second, 0)).toBe(false);
  });

  it('пройденный участок открывает следующий, и ровно один', () => {
    expect(isSegmentUnlocked(ZONES, { [first]: 1 }, first, 1)).toBe(true);
    expect(isSegmentUnlocked(ZONES, { [first]: 1 }, first, 2)).toBe(false);
  });

  it('пройденная зона целиком открывает первый участок следующей', () => {
    expect(isSegmentUnlocked(ZONES, { [first]: 3 }, second, 0)).toBe(false);
    expect(isSegmentUnlocked(ZONES, { [first]: 4 }, second, 0)).toBe(true);
    // Через одну зону не перепрыгнуть.
    expect(isSegmentUnlocked(ZONES, { [first]: 4 }, ZONES[2]?.id ?? '', 0)).toBe(false);
  });

  it('УРОВЕНЬ ИГРОКА В ОТПИРАНИИ НЕ УЧАСТВУЕТ', () => {
    /* Прежний замок считался от `players.level`. Аргумента для него
       здесь нет вовсе — это то же свойство подписи, что у `enemyLevel`,
       и проверяется так же. */
    expect(isSegmentUnlocked.length).toBe(4);
  });

  it('номер вне 0..3 закрыт, а не открыт по умолчанию', () => {
    expect(isSegmentUnlocked(ZONES, { [first]: 4 }, first, 4)).toBe(false);
    expect(isSegmentUnlocked(ZONES, { [first]: 4 }, first, -1)).toBe(false);
    expect(isSegmentUnlocked(ZONES, { [first]: 4 }, 'такой-зоны-нет', 0)).toBe(false);
  });
});

describe('монстры', () => {
  it('ключи уникальны', () => {
    const keys = MONSTERS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('каждый монстр приписан к существующей зоне и входит в её пул', () => {
    // Монстр, не попавший ни в один пул, — это контент, которого игрок
    // не увидит никогда: запись есть, встречи нет.
    for (const monster of MONSTERS) {
      const zone = zoneSpec(monster.zone);
      expect(zone, `монстр «${monster.key}» ссылается на зону «${monster.zone}»`).toBeDefined();
      if (zone === undefined) continue;
      const listed = zone.monsters.includes(monster.key) || zone.boss === monster.key;
      expect(listed, `«${monster.key}» не входит в пул зоны «${zone.id}»`).toBe(true);
    }
  });

  it('у каждого монстра есть название', () => {
    for (const monster of MONSTERS) {
      expect(ru[`monster.${monster.key}`], `нет названия монстра «${monster.key}»`).toBeTruthy();
    }
  });

  it('риг существует и несёт узлы-привязки', () => {
    /* `head` и `torso` — точки, к которым рендер вешает всплывающие
       числа и всплески (animations.json, stage). Риг без них падает
       не на сборке, а в бою у игрока. */
    for (const monster of MONSTERS) {
      const rig = (RIGS as Record<string, (typeof RIGS)['humanoid'] | undefined>)[monster.rig];
      expect(rig, `нет рига «${monster.rig}» у монстра «${monster.key}»`).toBeDefined();
      if (rig === undefined) continue;

      const names = new Set(rig.nodes.map((n) => n.name));
      for (const required of REQUIRED_NODES) {
        expect(names.has(required), `риг «${monster.rig}» без узла «${required}»`).toBe(true);
      }
    }
  });

  it('перекраска ссылается только на существующие цвета палитры', () => {
    // Цвет мимо палитры — это ассет, про который забыли (ART-BIBLE §3),
    // и заметят его через месяц на скриншоте.
    for (const monster of MONSTERS) {
      for (const [from, to] of Object.entries(monster.recolor ?? {})) {
        expect(palette[from], `${monster.key}: нет цвета «${from}»`).toBeDefined();
        expect(palette[to], `${monster.key}: нет цвета «${to}»`).toBeDefined();
      }
    }
  });

  it('перекраска подменяет цвет, который в риге ЕСТЬ', () => {
    // Подмена несуществующего ключа тихо не делает ничего: монстр
    // выглядит как соседний, и понять почему нельзя.
    for (const monster of MONSTERS) {
      const rig = (RIGS as Record<string, (typeof RIGS)['humanoid'] | undefined>)[monster.rig];
      if (rig === undefined) continue;
      const used = new Set(rig.nodes.map((n) => n.color));
      for (const from of Object.keys(monster.recolor ?? {})) {
        expect(used.has(from), `${monster.key}: в риге «${monster.rig}» нет цвета «${from}»`).toBe(
          true,
        );
      }
    }
  });

  it('перекраска не пускает в монстров городские цвета', () => {
    /* Тёплое золото и чистая белизна принадлежат вещам из Мунды
       (ART-BIBLE §8, LORE §8): «городскую вещь видно раньше, чем
       прочитаешь название». Монстр в городском цвете стирает это
       правило молча. */
    for (const monster of MONSTERS) {
      for (const to of Object.values(monster.recolor ?? {})) {
        expect(palette[to]?.reserved ?? false, `${monster.key}: городской цвет «${to}»`).toBe(
          false,
        );
      }
    }
  });

  it('классы и трейты объявлены существующие', () => {
    for (const monster of MONSTERS) {
      expect(ARMOR_CLASSES).toContain(monster.armorClass);
      expect(WEAPON_CLASSES).toContain(monster.weaponClass);
      for (const trait of monster.traits) expect(ALL_TRAIT_IDS).toContain(trait);
    }
  });

  it('монстры одной зоны различаются силуэтом ИЛИ цветом', () => {
    /* Иначе три противника зоны выглядят одинаково, и «посмотри
       на врага и переоденься» (§4.3) перестаёт работать: смотреть
       не на что. */
    for (const zone of ZONES) {
      const looks = [...zone.monsters, zone.boss].map((key) => {
        const m = monsterSpec(key);
        return `${m.rig}:${JSON.stringify(m.recolor ?? {})}`;
      });
      expect(new Set(looks).size, `зона «${zone.id}»: одинаковые монстры`).toBe(looks.length);
    }
  });
});
/**
 * СОБАЧЬЕГО СИЛУЭТА В ИГРЕ НЕТ. Решение человека.
 *
 * Первая попытка была переименованием: «Одичавшая собака» стала
 * «Трупными воронами», а риг остался четвероногим — на арене игрок
 * видел ту же собаку под другим именем. Имя живёт в локали, силуэт
 * в риге, и одно другое не заменяет.
 *
 * Тест держит ОБЕ стороны: и что рига больше нет, и что ни один монстр
 * на него не ссылается. Проверять только вторую было бы мало —
 * неиспользуемый риг вернулся бы в чей-нибудь новый монстр.
 */
describe('в игре нет собак', () => {
  it('рига `beast` не существует', () => {
    expect(Object.keys(RIGS)).not.toContain('beast');
    expect(FIGHTER_RIG_IDS as readonly string[]).not.toContain('beast');
  });

  it('ни один монстр не ссылается на звериный риг', () => {
    expect(MONSTERS.length, 'монстров нет — проверять нечего').toBeGreaterThan(0);
    for (const monster of MONSTERS) {
      expect(monster.rig, `монстр «${monster.key}»`).not.toBe('beast');
    }
  });

  it('ни в одном ключе монстра и ни в одном риге нет собаки по имени', () => {
    /* Ключи читает человек, и «пёс» в ключе — это заявка на силуэт,
       который потом кто-нибудь и нарисует. Список узкий намеренно:
       широкий отлавливал бы `bloodhound` в названии трейта и мешал бы
       работать вместо того, чтобы держать правило. */
    const forbidden = ['dog', 'hound', 'puppy', 'wolf'];
    const names = [...MONSTERS.map((m) => m.key), ...Object.keys(RIGS)];

    for (const name of names) {
      for (const word of forbidden) {
        expect(name.toLowerCase(), `«${name}» содержит «${word}»`).not.toContain(word);
      }
    }
  });

  it('заменившие риги действительно РАЗНЫЕ формы, а не копии', () => {
    // Иначе «заменили силуэт» прошло бы и на двух одинаковых ригах
    // под разными именами.
    const corvid = RIGS.corvid.nodes.map((n) => `${n.name}:${n.size.join(',')}`).sort();
    const crawler = RIGS.crawler.nodes.map((n) => `${n.name}:${n.size.join(',')}`).sort();
    expect(corvid).not.toEqual(crawler);

    // И у птицы есть клюв, а у бесформенного нет ни одной ноги:
    // это то, ЧЕМ они читаются, и без этого они снова неразличимы.
    expect(RIGS.corvid.nodes.some((n) => n.name === 'beak')).toBe(true);
    expect(RIGS.crawler.nodes.some((n) => n.name.startsWith('leg'))).toBe(false);
    expect(RIGS.corvid.nodes.some((n) => n.name.startsWith('leg'))).toBe(true);
  });
});
