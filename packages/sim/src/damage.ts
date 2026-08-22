import type { BattleEvent, CombatBalance, RollBreakdown } from '@extramundum/shared';

import {
  atkMultiplier,
  critChance,
  dodgeChance,
  effectiveStats,
  ilvlScale,
  matchupMultiplier,
  mitigation,
  type FighterState,
} from './fighter.js';
import type { Rng } from './rng.js';

/**
 * Пайплайн удара. GDD §4.2, восемь шагов строго по порядку.
 *
 * **Каждый шаг — отдельный бросок.** В v1.0 уклонение и блок делили
 * один `r` внутри `pickMove()`, из-за чего шанс блока зависел от шанса
 * уклонения: поднимаешь AGI — блок работает иначе, хотя щит тот же
 * (GDD §13, пункт 5). Здесь на каждую проверку идёт свой вызов `rng`,
 * и на независимость есть статистический тест.
 *
 * **Число бросков за удар зависит только от ВЕТКИ, а не от бойцов.**
 * Избегание — 1, уклонение — 2, попадание — 5. Ни статы, ни трейты,
 * ни снаряжение на это число не влияют, и на это есть тест. Свойство
 * нужно матрице винрейтов: если бросок тратится условно, два билда,
 * отличающиеся одним коэффициентом, расходятся потоком генератора,
 * и матрица меряет смещение выборки вместо силы правки. Ровно так
 * `slippery` с нулевым множителем крита показал на четыре пункта
 * больше, чем с множителем 0.05.
 *
 * **Числа оружия участвуют напрямую.** `dmgMin/dmgMax` — это урон,
 * ATK — множитель. В v1.0 к ATK прибавлялся средний урон оружия, а потом
 * бралось 80% от суммы, и числа в тултипе не имели отношения
 * к происходящему (GDD §13, пункт 4).
 */

export type AttackOutcome =
  | { readonly kind: 'dodged'; readonly events: readonly BattleEvent[] }
  | {
      readonly kind: 'hit';
      readonly damage: number;
      readonly crit: boolean;
      readonly roll: RollBreakdown;
      readonly events: readonly BattleEvent[];
    };

/**
 * Разрешает один удар и ВОЗВРАЩАЕТ результат, не применяя его.
 * Применение — в resolve.ts, там же, где мутируется состояние: так
 * видно, что урон снимается ровно один раз и ровно в момент хода.
 */
export function resolveAttack(
  attacker: FighterState,
  defender: FighterState,
  balance: CombatBalance,
  rng: Rng,
  attackerIndex: 0 | 1,
  defenderIndex: 0 | 1,
): AttackOutcome {
  const events: BattleEvent[] = [];

  // Статы читаются ОДИН раз на удар и уже с учётом активных статусов.
  // Читать `config` напрямую здесь нельзя: тогда hex, fury и chill
  // существовали бы в описании и не существовали в бою.
  const att = effectiveStats(attacker, defender, balance);
  const def = effectiveStats(defender, attacker, balance);

  // ── Шаг 0. Избегание. Удар не состоялся вовсе (GDD §4.2).
  //    Отдельный бросок ДО уклонения: общий связал бы их так же, как
  //    в v1.0 были связаны уклонение и блок.
  //
  //    Бросок БЕЗУСЛОВНЫЙ. Прежнее `avoidChance > 0 && ...` экономило
  //    вызов и ровно тем ломало сравнимость: два билда, отличающиеся
  //    только нулевым шансом избегания, тратили разное число бросков
  //    и расходились с этого места. См. `rng.chance` и шапку файла.
  if (rng.chance(def.avoidChance)) {
    events.push({ t: 'dodge', actor: defenderIndex, mitigated: 0 });
    return { kind: 'dodged', events };
  }

  // ── Шаг 1. Уклонение. Промах, урона нет.
  const dodge = dodgeChance(def.agi, att.accuracy, balance);
  if (rng.chance(dodge)) {
    events.push({ t: 'dodge', actor: defenderIndex, mitigated: 0 });
    return { kind: 'dodged', events };
  }

  // ── Шаг 2. Блок. Гасит удар только при щите в оффхенде.
  //
  //    Бросок делается ВСЕГДА, даже без щита. Шаг пайплайна существует
  //    у всех, а щит — его вход, как броня вход шага 6. Прежний вариант
  //    бросал только при щите, и тогда число бросков за удар зависело
  //    от снаряжения: бойцы со щитом и без него расходились потоком
  //    там, где исход ещё совпадал.
  //    Тип оффхенда на ЧИСЛО бросков не влияет: блок бросается у всех,
  //    включая тех, у кого в оффхенде второе оружие или фокус. Их шанс
  //    блока просто ноль.
  const offhand = defender.config.offhand;
  const shield = offhand !== null && offhand.kind === 'shield' ? offhand : null;
  const blockRoll = rng.chance(shield?.blockChance ?? 0);
  const blocked = shield !== null && blockRoll;
  // Трейт может переопределить силу блока (fortress: гасит полностью).
  const blockReduction = blocked ? (def.blockReductionOverride ?? shield.blockReduction) : 0;

  // ── Шаг 3. Базовый ролл оружия × масштаб уровня предмета.
  //
  //    Второе оружие в оффхенде складывается в ТОТ ЖЕ бросок, а не
  //    добавляет свой. Отдельный бросок изменил бы их число за удар,
  //    и билд со вторым оружием разошёлся бы потоком генератора с тем,
  //    у кого оффхенд пуст, — см. шапку файла.
  const weapon = attacker.config.weapon;
  const mainhand = attacker.config.offhand;
  const extra = mainhand !== null && mainhand.kind === 'weapon' ? mainhand : null;
  const lo =
    Math.min(weapon.dmgMin, weapon.dmgMax) +
    (extra === null ? 0 : Math.min(extra.dmgMin, extra.dmgMax));
  const hi =
    Math.max(weapon.dmgMin, weapon.dmgMax) +
    (extra === null ? 0 : Math.max(extra.dmgMin, extra.dmgMax));
  const weaponRoll = lo + rng.next() * (hi - lo);
  const scale = ilvlScale(weapon.ilvl, balance);

  // ── Шаг 4. Множитель ATK.
  // Множители трейтов входят в множитель атаки, а не отдельным полем
  // разбора: формат лога от этого не меняется, а произведение шагов
  // по-прежнему даёт итог.
  const atkMult =
    atkMultiplier(att.atk, balance, att.attackMultiplierBonus) *
    att.outgoingDamageMultiplier *
    def.incomingDamageMultiplier;

  // ── Шаг 5. Матчап «класс оружия × класс брони».
  const matchup = matchupMultiplier(weapon.class, defender.config.armorClass, balance);

  // ── Шаг 6. Митигация бронёй.
  const effectiveArmor = def.armor * (1 - att.armorPenetration);
  const dr = mitigation(effectiveArmor, attacker.config.level, balance);

  // ── Шаг 7. Крит. Тоже отдельный бросок.
  //    Гарантия трейта заменяет бросок, а не складывается с ним: бросок
  //    всё равно делается, чтобы поток генератора не зависел от того,
  //    взведён трейт или нет — иначе один и тот же сид давал бы разные
  //    бои у бойцов с одинаковым снаряжением.
  const critRoll = rng.chance(
    critChance(att.agi, attacker.config.critBonus, balance) * def.enemyCritMultiplier,
  );
  const crit = att.guaranteedCrit || critRoll;
  const critMult = crit ? balance.damage.critMultiplier : 1;

  // ── Шаг 8. Эффекты — M1b и M1c. Здесь их нет, и место под них не занято
  //    заглушками: пустой хук выглядел бы как реализованная механика.

  // ── Шаг 4 (продолжение). Семейство «Мощь» — процент УРОНА (GDD §6.1).
  //    Отдельным множителем, а не внутри atkMult: иначе журнал показал бы
  //    одно число вместо двух, и вклад снаряжения стал бы неотличим
  //    от вклада статов.
  const might = att.mightMultiplier;

  const beforeBlock = weaponRoll * scale * atkMult * might * matchup * (1 - dr) * critMult;
  const raw = beforeBlock * (1 - blockReduction);
  const final = Math.max(0, Math.round(raw));

  const roll: RollBreakdown = {
    weaponRoll,
    ilvlScale: scale,
    atkMultiplier: atkMult,
    mightMultiplier: might,
    matchupMultiplier: matchup,
    mitigation: dr,
    critMultiplier: critMult,
    blockReduction,
    final,
  };

  events.push({ t: 'attack', actor: attackerIndex, move: 'basic', roll });

  if (blocked) {
    // Сколько сняли блоком — в тех же единицах, что и урон: игрок должен
    // видеть «щит съел 14», а не «щит сработал».
    const mitigated = Math.max(0, Math.round(beforeBlock) - final);
    events.push({ t: 'block', actor: defenderIndex, mitigated });
  }

  return { kind: 'hit', damage: final, crit, roll, events };
}
