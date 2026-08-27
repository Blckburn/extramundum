import { combatBalanceSchema, type CombatBalance, type FighterConfig } from '@extramundum/shared';
import balanceJson from '../../../data/balance.json' with { type: 'json' };

/**
 * Обвязка тестов движка.
 *
 * Коэффициенты берутся из НАСТОЯЩЕГО balance.json, а не из выдуманных
 * чисел: тест на подобранных константах доказывал бы, что формула
 * совпадает сама с собой. Здесь он доказывает, что она совпадает
 * с тем, во что игра играет.
 *
 * Импорт файла живёт в тестах, а не в движке: сам движок коэффициенты
 * не читает, они приходят аргументом (инвариант 2).
 */
export const balance: CombatBalance = combatBalanceSchema.parse(balanceJson);

/** Боец «по умолчанию»: голые единицы, чтобы отклонение было видно. */
export function fighter(overrides: Partial<FighterConfig> = {}): FighterConfig {
  return {
    level: 1,
    atk: 0,
    def: 0,
    agi: 0,
    spd: 10,
    pathBonusHp: 0,
    gearBonusHp: 0,
    accuracy: 0,
    armor: 0,
    armorClass: 'medium',
    critBonus: 0,
    weapon: { dmgMin: 10, dmgMax: 10, ilvl: 1, class: 'balanced' },
    offhand: null,
    percentAffixes: { might: [], bastion: [], swiftness: [] },
    statuses: [],
    traits: [],
    ...overrides,
  };
}
