import {
  monsterSpecSchema,
  zoneIdSchema,
  zoneSpecSchema,
  type MonsterSpec,
  type ZoneId,
  type ZoneSpec,
} from '@extramundum/shared';

import monstersJson from './monsters.json' with { type: 'json' };
import zonesJson from './zones.json' with { type: 'json' };

/**
 * Зоны и монстры. GDD §7.4, §7.5.
 *
 * Разбираются схемой ЗДЕСЬ, один раз, как палитра, риги и базы
 * предметов: кривая запись падает на сборке, а не превращается
 * в противника с `undefined` в уроне у игрока.
 */

export const ZONES: readonly ZoneSpec[] = zonesJson.zones.map((zone) => zoneSpecSchema.parse(zone));

export const MONSTERS: readonly MonsterSpec[] = monstersJson.monsters.map((monster) =>
  monsterSpecSchema.parse(monster),
);

const zonesById = new Map(ZONES.map((zone) => [zone.id, zone]));
const monstersByKey = new Map(MONSTERS.map((monster) => [monster.key, monster]));

/**
 * Зона по идентификатору.
 *
 * Возвращает `undefined` для зон, которых ещё нет: `rift` объявлен
 * в перечислении, но отложен до M4 (§11). Это НЕ ошибка данных —
 * в отличие от неизвестного монстра, — и потому не бросок, а `undefined`:
 * решать, что делать с неготовой зоной, обязан вызывающий, а не
 * справочник.
 */
export function zoneSpec(id: ZoneId): ZoneSpec | undefined {
  return zonesById.get(id);
}

/** Зоны, в которые уже можно войти: с монстрами и боссом. */
export const PLAYABLE_ZONE_IDS: readonly ZoneId[] = ZONES.map((zone) => zone.id);

/**
 * Монстр по ключу. Неизвестный ключ — ошибка ДАННЫХ, а не тихий null:
 * зона, ссылающаяся на несуществующего монстра, обязана падать
 * на сборке, а не выдавать пустого противника в рейде.
 */
export function monsterSpec(key: string): MonsterSpec {
  const monster = monstersByKey.get(key);
  if (monster === undefined) throw new Error(`нет монстра «${key}» в monsters.json`);
  return monster;
}

export { zoneIdSchema };
