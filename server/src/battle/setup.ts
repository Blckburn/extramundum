import { balance as balanceData } from '@extramundum/data';
import {
  combatBalanceSchema,
  fighterConfigSchema,
  type CombatBalance,
  type Difficulty,
  type FighterConfig,
  type PlayerProfile,
} from '@extramundum/shared';

/**
 * Сборка бойцов для симуляции.
 *
 * Инвариант 1: конфигурация игрока строится ИЗ ПРОФИЛЯ, прочитанного
 * из БД по проверенной сессии. Клиент не передаёт ни одного числа,
 * влияющего на бойца, — и не сможет, потому что схема запроса таких
 * полей не содержит.
 *
 * Инвариант 5: числа берутся из balance.json. Здесь нет ни одной
 * константы, кроме имён полей.
 */

/**
 * Коэффициенты проверяются ОДИН раз при загрузке модуля. Иначе первая
 * же опечатка в balance.json всплыла бы как `undefined` посреди боя,
 * то есть как NaN в уроне и молча испорченный лог.
 */
export const combatBalance: CombatBalance = combatBalanceSchema.parse(balanceData);

const unarmed = balanceData.unarmed;
const sparring = balanceData.sparring;
const difficulties = balanceData.raid.difficulty;

/**
 * Боец из профиля игрока.
 *
 * Экипировки пока нет: предметы, аффиксы и лут — это M3. До тех пор
 * боец выходит в бой с голыми кулаками и без брони. Это честнее, чем
 * выдать ему выдуманное снаряжение: превью показывало бы шанс победы
 * для персонажа, которого не существует.
 */
export function fighterFromProfile(profile: PlayerProfile): FighterConfig {
  return fighterConfigSchema.parse({
    level: profile.level,
    atk: profile.statAtk,
    def: profile.statDef,
    agi: profile.statAgi,
    spd: profile.statSpd,
    // Пути уровня — M3 вместе с драфтом карточек. Поле уже есть, чтобы
    // при их появлении не пришлось трогать формулу HP (GDD §13, пункт 2).
    pathBonusHp: 0,
    accuracy: 0,
    armor: 0,
    armorClass: 'medium',
    critBonus: 0,
    weapon: {
      dmgMin: unarmed.dmgMin,
      dmgMax: unarmed.dmgMax,
      ilvl: unarmed.ilvl,
      class: unarmed.class,
    },
    offhand: null,
  });
}

/**
 * Спарринг-манекен.
 *
 * Это НЕ противник из зоны: генерация врагов, их снаряжение и лут —
 * M3 (GDD §11). Манекен — набор чисел, отмасштабированный от уровня
 * игрока со сдвигом по сложности, и ничего кроме. У него нет ни имени,
 * ни поведения, ни наград.
 *
 * Зона на его силу пока не влияет, и это осознанно: подобрать «примерно
 * правдоподобную» силу для каждой зоны значило бы придумать баланс зон
 * раньше, чем появятся сами зоны. Ответ эндпоинта помечен `basis`,
 * чтобы клиент не выдавал это число за оценку по зоне.
 */
export function sparringDummy(playerLevel: number, difficulty: Difficulty): FighterConfig {
  const offset = difficulties[difficulty].enemyLevelOffset;
  const level = Math.max(1, playerLevel + offset);
  const stat = Math.round(level * sparring.statPerLevel);

  return fighterConfigSchema.parse({
    level,
    atk: stat,
    def: stat,
    agi: stat,
    spd: stat,
    pathBonusHp: 0,
    accuracy: 0,
    armor: level * sparring.armorPerLevel,
    armorClass: sparring.armorClass,
    critBonus: 0,
    weapon: {
      dmgMin: sparring.weapon.dmgMin,
      dmgMax: sparring.weapon.dmgMax,
      ilvl: level,
      class: sparring.weapon.class,
    },
    offhand: null,
  });
}
