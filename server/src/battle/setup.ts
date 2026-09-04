import { balance as balanceData } from '@extramundum/data';
import {
  combatBalanceSchema,
  fighterConfigSchema,
  type CombatBalance,
  type Difficulty,
  type FighterConfig,
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
 *
 * Сборка бойца ИГРОКА живёт в `../items/loadout.ts` — там же, где
 * читается надетое. Двух мест, собирающих одного и того же бойца,
 * быть не должно: они разошлись бы, и превью обещало бы одно,
 * а бой давал другое.
 */

/**
 * Коэффициенты проверяются ОДИН раз при загрузке модуля. Иначе первая
 * же опечатка в balance.json всплыла бы как `undefined` посреди боя,
 * то есть как NaN в уроне и молча испорченный лог.
 */
export const combatBalance: CombatBalance = combatBalanceSchema.parse(balanceData);

const sparring = balanceData.sparring;

/**
 * Спарринг-манекен.
 *
 * Это НЕ противник из зоны: настоящий враг приходит из участка, и его
 * уровень от игрока не зависит вовсе. Манекен — набор чисел
 * от уровня ИГРОКА, и ничего кроме. У него нет ни имени, ни поведения,
 * ни наград.
 *
 * СЛОЖНОСТЬ НА НЕГО НЕ ВЛИЯЕТ, и это следствие правки, а не упущение:
 * тир несёт множитель силы ЗОНЫ, а зоны у манекена нет. Прежде тир
 * двигал его уровень — но тем же сдвигом, что и у настоящего врага,
 * а сдвиг был одинаков у всех трёх тиров и потому ничего не значил.
 * Ответ эндпоинта помечен `basis`, чтобы клиент не выдавал это число
 * за оценку по зоне.
 */
export function sparringDummy(playerLevel: number, _difficulty: Difficulty): FighterConfig {
  const level = Math.max(1, playerLevel);
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
