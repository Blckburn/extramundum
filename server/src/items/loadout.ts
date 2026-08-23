import { balance as balanceData, itemBase } from '@extramundum/data';
import {
  baseValue,
  type EquipmentSlot,
  type FighterConfig,
  type Item,
  type ItemDerived,
  type ItemView,
  type LoadoutStats,
  type OffhandConfig,
  type PlayerProfile,
  type WeaponClass,
  weaponClassSchema,
} from '@extramundum/shared';
import { mightMultiplier } from '@extramundum/sim';

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

/** Все аффиксы «Мощи» набора — списком, как их ждёт движок. */
function mightAffixes(loadout: Loadout): number[] {
  const values: number[] = [];
  for (const item of loadout.values()) {
    for (const affix of item.affixes) {
      if (affix.family === 'might') values.push(affix.value);
    }
  }
  return values;
}

function strengthBonus(loadout: Loadout): number {
  let total = 0;
  for (const item of loadout.values()) {
    for (const affix of item.affixes) {
      if (affix.family === 'strength') total += affix.value;
    }
  }
  return total;
}

function armorTotal(loadout: Loadout): number {
  let total = 0;
  for (const item of loadout.values()) total += derive(item).armor ?? 0;
  return total;
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
    atk: profile.statAtk + strengthBonus(loadout),
    def: profile.statDef,
    agi: profile.statAgi,
    spd: profile.statSpd,
    // Пути уровня — M3c вместе с драфтом карточек.
    pathBonusHp: 0,
    accuracy: 0,
    armor: armorTotal(loadout),
    armorClass:
      chestItem === undefined ? 'medium' : (itemBase(chestItem.baseKey).armorClass ?? 'medium'),
    critBonus: 0,
    weapon,
    offhand: offhandConfig(loadout.get('offhand')),
    damageAffixes: mightAffixes(loadout),
    statuses: [],
    traits: [],
  };
}

/** Производные характеристики набора — их сравнивает превью. */
export function loadoutStats(profile: PlayerProfile, loadout: Loadout): LoadoutStats {
  const config = fighterFromLoadout(profile, loadout);
  const worn = mightAffixes(loadout);

  return {
    atk: config.atk,
    armor: config.armor,
    dmgMin: config.weapon.dmgMin + (config.offhand?.kind === 'weapon' ? config.offhand.dmgMin : 0),
    dmgMax: config.weapon.dmgMax + (config.offhand?.kind === 'weapon' ? config.offhand.dmgMax : 0),
    mightMultiplier: mightMultiplier(worn, combatBalance),
    mightWorn: worn.length,
    mightBudget: combatBalance.items.mightBudget,
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
  const counted = loadout === null ? null : countedMight(loadout);

  return {
    ...item,
    derived: derive(item),
    ...(base.offhandKind === undefined ? {} : { offhandKind: base.offhandKind }),
    ...(base.weaponClass === undefined ? {} : { weaponClass: base.weaponClass }),
    ...(base.armorClass === undefined ? {} : { armorClass: base.armorClass }),
    affixes: item.affixes.map((affix) => {
      if (affix.family !== 'might' || counted === null) return affix;
      // Одинаковые значения неразличимы, поэтому расходуется квота:
      // из двух аффиксов по 0.15 считается ровно один, если бюджет занят.
      const quota = counted.get(affix.value) ?? 0;
      if (quota > 0) counted.set(affix.value, quota - 1);
      return { ...affix, counted: quota > 0 };
    }),
  };
}

/** Сколько экземпляров каждого значения «Мощи» попадает в бюджет. */
function countedMight(loadout: Loadout): Map<number, number> {
  const sorted = mightAffixes(loadout).sort((a, b) => b - a);
  const quota = new Map<number, number>();
  for (const value of sorted.slice(0, combatBalance.items.mightBudget)) {
    quota.set(value, (quota.get(value) ?? 0) + 1);
  }
  return quota;
}
