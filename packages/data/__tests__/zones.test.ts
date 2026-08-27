import { ALL_TRAIT_IDS, ARMOR_CLASSES, WEAPON_CLASSES, ZONE_IDS } from '@extramundum/shared';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { balance, MONSTERS, palette, RIGS, ZONES, monsterSpec, zoneSpec } from '../index.ts';

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
