import { balance as balanceData, itemBase } from '@extramundum/data';
import {
  baseValue,
  isPercentFamily,
  PERCENT_AFFIX_FAMILIES,
  type AffixFamily,
  type EquipmentSlot,
  type FighterConfig,
  type FlatAffixFamily,
  type Item,
  type ItemDerived,
  type ItemView,
  type LoadoutStats,
  type OffhandConfig,
  type PercentAffixes,
  type PercentAffixFamily,
  type PlayerProfile,
  type WeaponClass,
  weaponClassSchema,
} from '@extramundum/shared';
import { familyMultiplier, maxHp as maxHpOf } from '@extramundum/sim';

import { combatBalance } from '../battle/setup.ts';

/**
 * Сборка бойца из НАДЕТОГО. GDD §5.3, §6.1.
 *
 * Это то место, где предметы становятся боем. Всё, что сюда не попало,
 * для боя не существует — поэтому здесь же считается и то, что показывает
 * превью: две функции с разными правилами разошлись бы, и превью
 * обещало бы одно, а бой давал другое.
 *
 * Клиент в этой сборке не участвует ни одним числом: предметы приходят
 * из БД по владельцу.
 */

const ilvlScale = balanceData.items.ilvlScale;

/** Числа предмета после масштабирования по ilvl. GDD §6.1. */
export function derive(item: Item): ItemDerived {
  const base = itemBase(item.baseKey);
  const scale = (value: number): number =>
    Math.round(baseValue(value, item.ilvl, ilvlScale) * 10) / 10;

  return {
    ...(base.dmgMin === undefined ? {} : { dmgMin: scale(base.dmgMin) }),
    ...(base.dmgMax === undefined ? {} : { dmgMax: scale(base.dmgMax) }),
    ...(base.armor === undefined ? {} : { armor: scale(base.armor) }),
    // Шансы и доли по ilvl НЕ растут: вероятность блока 0.32 при ilvl 40
    // превратилась бы в 0.83, а при ilvl 60 — в единицу. Масштабируется
    // то, что измеряется в единицах урона и брони, а не в долях.
    ...(base.blockChance === undefined ? {} : { blockChance: base.blockChance }),
    ...(base.blockReduction === undefined ? {} : { blockReduction: base.blockReduction }),
    ...(base.statusPower === undefined ? {} : { statusPower: base.statusPower }),
  };
}

export type Loadout = ReadonlyMap<EquipmentSlot, Item>;

function weaponClassOf(baseKey: string): WeaponClass {
  const weaponClass = itemBase(baseKey).weaponClass;
  if (weaponClass === undefined) throw new Error(`база «${baseKey}» в слоте оружия без класса`);
  return weaponClass;
}

/**
 * Значения одного семейства по всему набору — списком.
 *
 * ОДНА функция на все семь, а не семь похожих: скопированный перебор
 * разошёлся бы при первой правке одного из них, и разошёлся бы молча —
 * аффикс просто перестал бы работать, оставшись в тултипе.
 */
function affixValues(loadout: Loadout, family: AffixFamily): number[] {
  const values: number[] = [];
  for (const item of loadout.values()) {
    for (const affix of item.affixes) {
      if (affix.family === family) values.push(affix.value);
    }
  }
  return values;
}

/** Сумма плоского семейства. Складывается в стат носителя, бюджета нет. */
function flatBonus(loadout: Loadout, family: FlatAffixFamily): number {
  let total = 0;
  for (const value of affixValues(loadout, family)) total += value;
  return total;
}

/** Процентные семейства — списками, как их ждёт движок: бюджет держит он. */
function percentAffixesOf(loadout: Loadout): PercentAffixes {
  return {
    might: affixValues(loadout, 'might'),
    bastion: affixValues(loadout, 'bastion'),
    swiftness: affixValues(loadout, 'swiftness'),
  };
}

/**
 * Броня со всех слотов плюс «Крепость».
 *
 * «Оплот» СЮДА НЕ ВХОДИТ: он множитель, и его держит движок вместе
 * с бюджетом семейства. Свернуть его здесь значило бы унести правило
 * туда, где его нечем проверить тестом.
 */
function armorTotal(loadout: Loadout): number {
  let total = 0;
  for (const item of loadout.values()) total += derive(item).armor ?? 0;
  return total + flatBonus(loadout, 'fortitude');
}

function offhandConfig(item: Item | undefined): OffhandConfig | null {
  if (item === undefined) return null;
  const base = itemBase(item.baseKey);
  const d = derive(item);

  switch (base.offhandKind) {
    case 'shield':
      return {
        kind: 'shield',
        blockChance: d.blockChance ?? 0,
        blockReduction: d.blockReduction ?? 0,
      };
    case 'weapon':
      return { kind: 'weapon', dmgMin: d.dmgMin ?? 0, dmgMax: d.dmgMax ?? 0 };
    case 'focus':
      return { kind: 'focus', statusPower: d.statusPower ?? 1 };
    default:
      // База в слоте оффхенда обязана объявить свой вид. Молча вернуть
      // null значило бы, что игрок надел предмет и ничего не получил.
      throw new Error(`база «${item.baseKey}» в слоте оффхенда без offhandKind`);
  }
}

/**
 * Боец из профиля и надетого.
 *
 * Без оружия боец выходит с голыми кулаками из `balance.unarmed` —
 * числа там намеренно жалкие, чтобы отсутствие оружия не выглядело
 * рабочим билдом. Класс брони берёт НАГРУДНИК (GDD §5.3), остальные
 * части дают только ARM и за класс не спорят.
 */
export function fighterFromLoadout(profile: PlayerProfile, loadout: Loadout): FighterConfig {
  const unarmed = balanceData.unarmed;
  const weaponItem = loadout.get('weapon');
  const chestItem = loadout.get('chest');

  const weapon =
    weaponItem === undefined
      ? {
          dmgMin: unarmed.dmgMin,
          dmgMax: unarmed.dmgMax,
          ilvl: unarmed.ilvl,
          // Класс из JSON приходит строкой — сужается схемой, а не
          // приведением: опечатка в balance.json обязана падать здесь,
          // а не превращаться в отсутствующую строку таблицы матчапов.
          class: weaponClassSchema.parse(unarmed.class),
        }
      : {
          dmgMin: derive(weaponItem).dmgMin ?? 0,
          dmgMax: derive(weaponItem).dmgMax ?? 0,
          ilvl: weaponItem.ilvl,
          // База в слоте оружия обязана объявить класс: он участвует
          // в таблице матчапов, и «по умолчанию сбалансированное»
          // означало бы молча выданное преимущество или штраф.
          class: weaponClassOf(weaponItem.baseKey),
        };

  return {
    level: profile.level,
    atk: profile.statAtk + flatBonus(loadout, 'strength'),
    def: profile.statDef,
    agi: profile.statAgi,
    spd: profile.statSpd,
    // Пути уровня — M3c вместе с драфтом карточек.
    pathBonusHp: 0,
    // «Жила». ОТДЕЛЬНО от pathBonusHp: смешать два источника HP в одном
    // числе — это форма бага v1.0 из §13 пункта 2.
    gearBonusHp: flatBonus(loadout, 'vitality'),
    // «Верность руки». До M3b здесь стоял ноль, и точность из §4.2
    // существовала в документе и не существовала в игре.
    accuracy: flatBonus(loadout, 'truehand'),
    armor: armorTotal(loadout),
    armorClass:
      chestItem === undefined ? 'medium' : (itemBase(chestItem.baseKey).armorClass ?? 'medium'),
    critBonus: 0,
    // HP входа — по умолчанию максимум. Перенос между боями забега
    // ставит сюда «сколько осталось» (§7.2), и делает это рейд,
    // а не сборка бойца: сборка не знает, идёт ли забег.
    startHp: null,
    weapon,
    offhand: offhandConfig(loadout.get('offhand')),
    percentAffixes: percentAffixesOf(loadout),
    statuses: [],
    traits: [],
  };
}

/**
 * Производные характеристики набора — их сравнивает превью.
 *
 * Числа здесь ТЕ ЖЕ, что уходят в бой: они берутся из собранного бойца,
 * а не считаются вторым способом. Второй способ разошёлся бы, и превью
 * обещало бы одно, а бой давал другое.
 */
export function loadoutStats(profile: PlayerProfile, loadout: Loadout): LoadoutStats {
  const config = fighterFromLoadout(profile, loadout);
  const budget = combatBalance.items.familyBudget;

  const percent = {} as Record<PercentAffixFamily, { worn: number; budget: number }>;
  for (const family of PERCENT_AFFIX_FAMILIES) {
    percent[family] = { worn: config.percentAffixes[family].length, budget: budget[family] };
  }

  return {
    atk: config.atk,
    // Броня ПОСЛЕ «Оплота»: множитель держит движок, поэтому и число
    // берётся у него, а не пересчитывается здесь.
    armor: config.armor * familyMultiplier(config.percentAffixes.bastion, combatBalance, 'bastion'),
    dmgMin: config.weapon.dmgMin + (config.offhand?.kind === 'weapon' ? config.offhand.dmgMin : 0),
    dmgMax: config.weapon.dmgMax + (config.offhand?.kind === 'weapon' ? config.offhand.dmgMax : 0),
    spd: config.spd * familyMultiplier(config.percentAffixes.swiftness, combatBalance, 'swiftness'),
    accuracy: config.accuracy,
    maxHp: maxHpOf(config, combatBalance),
    mightMultiplier: familyMultiplier(config.percentAffixes.might, combatBalance, 'might'),
    bastionMultiplier: familyMultiplier(config.percentAffixes.bastion, combatBalance, 'bastion'),
    swiftnessMultiplier: familyMultiplier(
      config.percentAffixes.swiftness,
      combatBalance,
      'swiftness',
    ),
    percentAffixes: percent,
  };
}

/**
 * Предмет для показа: числа после ilvl плюс пометка, какие аффиксы
 * «Мощи» реально считаются.
 *
 * Пометка ставится ТОЛЬКО надетым и только «Мощи»: для лежащего
 * в стеше вопрос не имеет смысла, пока он не надет вместе с остальными.
 */
export function toView(item: Item, loadout: Loadout | null): ItemView {
  const base = itemBase(item.baseKey);
  const quotas = loadout === null ? null : countedQuotas(loadout);

  return {
    ...item,
    derived: derive(item),
    ...(base.offhandKind === undefined ? {} : { offhandKind: base.offhandKind }),
    ...(base.weaponClass === undefined ? {} : { weaponClass: base.weaponClass }),
    ...(base.armorClass === undefined ? {} : { armorClass: base.armorClass }),
    affixes: item.affixes.map((affix) => {
      if (quotas === null || !isPercentFamily(affix.family)) return affix;
      const counted = quotas[affix.family];
      // Одинаковые значения неразличимы, поэтому расходуется квота:
      // из двух аффиксов по 0.15 считается ровно один, если бюджет занят.
      const quota = counted.get(affix.value) ?? 0;
      if (quota > 0) counted.set(affix.value, quota - 1);
      return { ...affix, counted: quota > 0 };
    }),
  };
}

/** Сколько экземпляров каждого значения попадает в бюджет — по семействам. */
function countedQuotas(loadout: Loadout): Record<PercentAffixFamily, Map<number, number>> {
  const quotas = {} as Record<PercentAffixFamily, Map<number, number>>;
  for (const family of PERCENT_AFFIX_FAMILIES) {
    const sorted = affixValues(loadout, family).sort((a, b) => b - a);
    const quota = new Map<number, number>();
    for (const value of sorted.slice(0, combatBalance.items.familyBudget[family])) {
      quota.set(value, (quota.get(value) ?? 0) + 1);
    }
    quotas[family] = quota;
  }
  return quotas;
}
