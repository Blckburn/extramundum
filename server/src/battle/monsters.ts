import { balance as balanceData } from '@extramundum/data';
import { monsterSpec, zoneSpec } from '@extramundum/data/zones';
import {
  enemyLevel,
  fighterConfigSchema,
  type Difficulty,
  type FighterConfig,
  type MonsterSpec,
  type ZoneId,
  type ZoneSpec,
} from '@extramundum/shared';

/**
 * Монстр как боец. GDD §7.3, §7.4, §7.5.
 *
 * ЗДЕСЬ НЕТ НИ ОДНОГО ИМЕНИ МОНСТРА И НИ ОДНОГО ЕГО ЧИСЛА. Всё приходит
 * из `packages/data`: кривая роста — из `balance.monsters`, наклон
 * конкретного монстра — из его записи, ограничение уровня — из зоны.
 * Новый монстр не требует правки этого файла.
 *
 * Это то же правило, что у ригов и палитры, и та же причина: контент,
 * заведённый кодом, приходится править кодом — а значит его никто
 * не правит.
 */

const curve = balanceData.monsters;
const difficulties = balanceData.raid.difficulty;

/**
 * Уровень врага для зоны и сложности. GDD §7.3 со сдвигом, §7.4
 * с ограничением диапазоном зоны.
 *
 * Формула живёт в `@extramundum/shared`, чтобы бой, превью и экран
 * выбора зоны считали её одинаково. Здесь только подстановка сдвига
 * из коэффициентов.
 */
export function monsterLevel(playerLevel: number, zone: ZoneSpec, difficulty: Difficulty): number {
  return enemyLevel(playerLevel, difficulties[difficulty].enemyLevelOffset, zone);
}

/**
 * Боец из записи монстра.
 *
 * Статы монстра — множители к общей кривой, а множитель зоны стоит
 * СВЕРХУ них. Разделение существенно: наклон монстра говорит, кто он
 * такой (быстрый, бронированный, бьющий), а множитель зоны — насколько
 * глубоко игрок забрался. Свести их в одно число значило бы, что
 * калибровка кривой зон меняет характеры монстров.
 */
export function monsterFighter(spec: MonsterSpec, level: number, power: number): FighterConfig {
  const stat = curve.baseStat + (level - 1) * curve.statPerLevel;
  const armor = curve.armorBase + level * curve.armorPerLevel;
  const scaled = (multiplier: number): number => Math.round(stat * multiplier * power);

  return fighterConfigSchema.parse({
    level,
    atk: scaled(spec.stats.atk),
    def: scaled(spec.stats.def),
    agi: scaled(spec.stats.agi),
    spd: scaled(spec.stats.spd),
    pathBonusHp: 0,
    gearBonusHp: 0,
    // Точность монстрам не выдаётся: это производная ЭКИПИРОВКИ (§4.2),
    // а экипировки у них нет. Ловкий игрок обязан уклоняться от них
    // в полную силу — на этом и держится ценность AGI против зон.
    accuracy: 0,
    armor: Math.round(armor * spec.armor * power),
    armorClass: spec.armorClass,
    critBonus: 0,
    weapon: {
      dmgMin: curve.weapon.dmgMin * spec.weapon.dmgMin,
      dmgMax: curve.weapon.dmgMax * spec.weapon.dmgMax,
      // ilvl оружия равен уровню: масштаб §6.1 применяет движок сам,
      // и монстр растёт с глубиной так же, как растёт лут.
      ilvl: level,
      class: spec.weaponClass,
    },
    offhand: null,
    percentAffixes: { might: [], bastion: [], swiftness: [] },
    // У монстра нет снаряжения, поэтому и аффиксов точности нет:
    // его точность — это его базовая характеристика и ничего больше.
    accuracyAffixes: [],
    statuses: [],
    traits: spec.traits,
  });
}

/** Зона по идентификатору. Незаготовленная зона — отказ, а не пустой бой. */
export function requireZone(id: ZoneId): ZoneSpec {
  const zone = zoneSpec(id);
  if (zone === undefined) {
    // `rift` объявлен в перечислении, но отложен до M4 (§11). Пустить
    // в него игрока значило бы отдать бой без противника.
    throw new Error(`зона «${id}» ещё не заготовлена`);
  }
  return zone;
}

/**
 * Кто встречает игрока в бою номер `fightIndex` (от нуля).
 *
 * ПЯТЫЙ БОЙ — БОСС (§7.5). Остальные выбираются из пула зоны броском
 * по сиду забега: клиент не может узнать состав следующего боя заранее,
 * потому что сид ему не отдаётся.
 */
export function monsterForFight(zone: ZoneSpec, fightIndex: number, roll: number): MonsterSpec {
  const last = balanceData.raid.fightsPerRun - 1;
  if (fightIndex >= last) return monsterSpec(zone.boss);

  const pool = zone.monsters;
  const at = Math.min(pool.length - 1, Math.max(0, Math.floor(roll * pool.length)));
  const key = pool[at];
  if (key === undefined) throw new Error(`пустой пул монстров у зоны «${zone.id}»`);
  return monsterSpec(key);
}
