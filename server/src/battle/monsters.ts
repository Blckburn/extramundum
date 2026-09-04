import { balance as balanceData } from '@extramundum/data';
import { zoneSpec } from '@extramundum/data/zones';
import {
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
 * конкретного монстра — из его записи, уровень — из участка зоны.
 * Новый монстр не требует правки этого файла.
 *
 * Это то же правило, что у ригов и палитры, и та же причина: контент,
 * заведённый кодом, приходится править кодом — а значит его никто
 * не правит.
 */

const curve = balanceData.monsters;
const difficulties = balanceData.raid.difficulty;

/**
 * Множитель силы врага: зона умножается на тир сложности. GDD §7.3.
 *
 * ОДНА функция на весь сервер: бой, превью и экран выбора обязаны
 * считать одинаково, а второе место разошлось бы с первым на ближайшей
 * правке.
 *
 * ТЯЖЕСТЬ ТИРА НЕСЁТ ЭТОТ МНОЖИТЕЛЬ, И ТОЛЬКО ОН. Раньше тир задавался
 * смещением уровня, и уровень оказался негодной единицей: у основания
 * диапазона зоны тир удваивал врага, а на верхушке схлопывался —
 * «опасно» и «кошмар» становились одним и тем же боем при разной оплате
 * лутом. С переходом на участки смещение убрано совсем: уровень врага
 * приходит из данных участка, и двигать его сложностью значило бы
 * вернуть ровно ту величину, из-за которой участки и появились.
 */
export function monsterPower(zone: ZoneSpec, difficulty: Difficulty): number {
  return zone.power * difficulties[difficulty].power;
}

/**
 * Оплата лутом за бой на этой сложности. GDD §7.3.
 *
 * ЭТО ТЕПЕРЬ КОНСТАНТА ТИРА И НИЧЕГО СВЕРХУ. Раньше на неё умножалась
 * доля уцелевшей разницы уровней игрока и врага: уровень врага был
 * зажат диапазоном зоны, и переросший игрок фармил первую зону
 * на «кошмаре» за полную цену при нулевом риске.
 *
 * Разницы уровней больше нет ни в каком виде — уровень врага приходит
 * из участка, — и множить стало не на что. Функция оставлена одна
 * на весь сервер по прежней причине: карточка зоны, панель забега
 * и начисление обязаны показывать одно число.
 */
export function zoneLootMultiplier(difficulty: Difficulty): number {
  return difficulties[difficulty].lootMultiplier;
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
 * Пятый бой участка — бой с боссом. GDD §7.5.
 *
 * ОДНА функция на весь сервер: от неё зависит и кто выйдет, и какой
 * у него уровень (босс берёт верх участка), и что засчитывается
 * прохождением участка. Три места, считающие «последний ли это бой»,
 * разошлись бы на первой правке длины забега.
 */
export function isBossFight(fightIndex: number): boolean {
  return fightIndex >= balanceData.raid.fightsPerRun - 1;
}
