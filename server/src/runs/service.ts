import { balance as balanceData, ITEM_BASES } from '@extramundum/data';
import { monsterSpec } from '@extramundum/data/zones';
import {
  isZoneUnlocked,
  lootBalanceSchema,
  zoneMinLevel,
  type Difficulty,
  type FightRewards,
  type MonsterSpec,
  type NextEnemy,
  type RunView,
  type ZoneSpec,
} from '@extramundum/shared';
import { generateItem, matchupMultiplier, maxHp as maxHpOf, resolveBattle } from '@extramundum/sim';
import { randomUUID } from 'node:crypto';

import { combatBalance } from '../battle/setup.ts';
import { monsterFighter, monsterLevel, requireZone } from '../battle/monsters.ts';
import type { Database } from '../db/client.ts';
import { AppError } from '../http/errors.ts';
import { fighterFromLoadout, toView } from '../items/loadout.ts';
import { loadoutOf } from '../items/repository.ts';
import type { PlayerProfile } from '@extramundum/shared';

import {
  applyFightOutcome,
  extractBag,
  findActiveRun,
  insertRun,
  spendPotion,
  type BagItem,
  type RunRow,
} from './repository.ts';

/**
 * Забег с эвакуацией. GDD §7.2, §7.3, §7.5.
 *
 * ЗДЕСЬ ЖИВЁТ ВСЁ, ЧТО ДЕЛАЕТ ИЗ АВТОБАТТЛЕРА ИГРУ ПРО РИСК: перенос HP
 * между боями, сумка, которая теряется, растущий множитель лута
 * и решение «уйти или дальше».
 *
 * Клиент не участвует ни одним числом. Он не может:
 *   — узнать состав будущих боёв: сид забега не покидает сервер;
 *   — переиграть бой: номер боя берётся из базы, а не из запроса;
 *   — отменить смерть: исход применяется той же транзакцией, что двигает
 *     счётчик боёв, и повторный запрос не находит строку в нужном
 *     состоянии.
 */

const raid = balanceData.raid;
const rewardsBalance = balanceData.rewards;
const loot = lootBalanceSchema.parse(balanceData.items);

/* ──────────────────────────── чтение состояния ───────────────────────── */

/**
 * Множитель лута на бой с данным номером. GDD §7.2.
 *
 * Растёт не с каждым боем, а с каждым ПРОЙДЕННЫМ РЕШЕНИЕМ: решений три
 * (после боёв 2, 3 и 4), и значений в лестнице тоже четыре. Первые два
 * боя идут по ×1.0 — до первой развилки игрок ничем не рисковал.
 */
export function lootMultiplierAt(fightIndex: number): number {
  const ladder = raid.lootMultiplierByFight;
  const step = Math.max(0, Math.min(ladder.length - 1, fightIndex - 1));
  return ladder[step] ?? 1;
}

/** Разрешена ли эвакуация. GDD §7.2: после боёв 2, 3 и 4. */
export function canExtractAt(fightIndex: number): boolean {
  return fightIndex >= 2 && fightIndex < raid.fightsPerRun;
}

/**
 * Бросок, выбирающий монстра для боя.
 *
 * Выводится из сида забега и номера боя, а не из общего генератора:
 * тогда «кто следующий» не зависит от того, сколько раз игрок обновил
 * экран, и совпадает с тем, что было показано в превью.
 */
function pickRoll(seed: string, fightIndex: number): number {
  let hash = 0x811c9dc5;
  const text = `${seed}:enemy:${fightIndex}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x100000000;
}

/** Кто ждёт в бою с данным номером. */
export function enemyFor(zone: ZoneSpec, fightIndex: number, seed: string): MonsterSpec {
  const last = raid.fightsPerRun - 1;
  if (fightIndex >= last) return monsterSpec(zone.boss);

  const pool = zone.monsters;
  const at = Math.min(pool.length - 1, Math.floor(pickRoll(seed, fightIndex) * pool.length));
  const key = pool[at];
  if (key === undefined) throw new Error(`пустой пул монстров у зоны «${zone.id}»`);
  return monsterSpec(key);
}

/* ──────────────────────────────── показ ──────────────────────────────── */

export type RunContext = {
  readonly profile: PlayerProfile;
  readonly row: RunRow;
};

/**
 * Состояние забега для клиента.
 *
 * Сид сюда НЕ ПОПАДАЕТ ни при каких условиях: с ним можно было бы
 * посчитать состав всех пяти боёв заранее, и решение «идти дальше»
 * перестало бы быть ставкой. Показывается только СЛЕДУЮЩИЙ противник —
 * ровно то, что §7.2 требует для решения.
 */
export async function runView(db: Database, ctx: RunContext): Promise<RunView> {
  const { profile, row } = ctx;
  const zone = requireZone(row.zone);
  const loadout = await loadoutOf(db, profile.id);
  const player = fighterFromLoadout(profile, loadout);
  const maxHp = maxHpOf(player, combatBalance);

  const finished = row.state !== 'active' || row.fightIndex >= raid.fightsPerRun;
  const next = finished ? null : nextEnemy(zone, row, profile, player.weapon.class);

  // Сумка показывается целиком: «содержимое сумки игроку известно,
  // он видел, как падал лут» (§7.2). Предметы в ней уже с номерами —
  // теми же, под которыми приедут в инвентарь.
  const bag = row.bag.map((item) => toView(item, null));

  return {
    runId: row.id,
    zone: row.zone,
    difficulty: row.difficulty,
    state: row.state,
    fightIndex: row.fightIndex,
    fightsTotal: raid.fightsPerRun,
    hp: Math.min(profile.hpCurrent, maxHp),
    maxHp,
    potionsLeft: row.potionsLeft,
    bag,
    lootMultiplier: lootMultiplierAt(row.fightIndex),
    next,
    canExtract: row.state === 'active' && canExtractAt(row.fightIndex),
  };
}

function nextEnemy(
  zone: ZoneSpec,
  row: RunRow,
  profile: PlayerProfile,
  playerWeapon: NextEnemy['weaponClass'],
): NextEnemy {
  const spec = enemyFor(zone, row.fightIndex, row.seed);
  return {
    key: spec.key,
    level: monsterLevel(profile.level, zone, row.difficulty),
    armorClass: spec.armorClass,
    weaponClass: spec.weaponClass,
    boss: spec.boss,
    // Матчап считает СЕРВЕР: «⚔ Твой молот против его кожи: ×0.90»
    // из §4.3 — это плашка с готовым числом, а не приглашение клиенту
    // умножать самому.
    matchup: matchupMultiplier(playerWeapon, spec.armorClass, combatBalance),
  };
}

/* ─────────────────────────────── операции ────────────────────────────── */

export async function startRun(
  db: Database,
  profile: PlayerProfile,
  input: { zone: RunRow['zone']; difficulty: Difficulty },
): Promise<RunView> {
  // Зона, которой ещё нет (`rift` отложен до M4), — отказ, а не бой
  // без противника.
  const zone = requireZone(input.zone);

  /* ЗАПЕРТАЯ ЗОНА — ОТКАЗ, и это не декорация.

     Уровень врага зажат диапазоном зоны (§7.3 плюс §7.4), поэтому
     в зоне выше своего уровня игрок видит ОДНОГО И ТОГО ЖЕ врага
     на всех трёх сложностях, а множители добычи там ×1 / ×1.6 / ×2.5.
     То есть «Кошмар» в переросшей зоне — бесплатное умножение добычи;
     сейчас оно ничего не даёт только потому, что там убивают. Как
     только снаряжение позволит выжить, это стало бы лучшей стратегией
     в игре, и чинить пришлось бы уже с накопленной добычей на руках. */
  if (!isZoneUnlocked(profile.level, zone)) {
    throw new AppError('forbidden', {
      messageKey: 'error.run.zoneLocked',
      message: `зона «${zone.id}» открывается с уровня ${zoneMinLevel(zone)}`,
    });
  }

  const existing = await findActiveRun(db, profile.id);
  if (existing !== null) {
    // Два забега сразу означали бы две сумки и возможность «переложить»
    // риск. Уникальный индекс в схеме не даст этого и на уровне базы.
    throw new AppError('conflict', {
      messageKey: 'error.run.alreadyActive',
      message: 'забег уже идёт',
    });
  }

  const loadout = await loadoutOf(db, profile.id);
  const maxHp = maxHpOf(fighterFromLoadout(profile, loadout), combatBalance);

  const row = await insertRun(db, {
    playerId: profile.id,
    zone: zone.id,
    difficulty: input.difficulty,
    seed: randomUUID(),
    potionsLeft: raid.potionChargesPerRun,
    maxHp,
  });

  return runView(db, { profile: row.profile, row: row.run });
}

export type FightResult = {
  readonly battleId: string;
  readonly log: ReturnType<typeof resolveBattle>['log'];
  readonly outcome: ReturnType<typeof resolveBattle>['outcome'];
  readonly maxHp: readonly [number, number];
  readonly enemy: string;
  readonly enemyLook: { readonly rig: string; readonly recolor?: Readonly<Record<string, string>> };
  readonly rewards: FightRewards;
  readonly run: RunView;
};

/**
 * Провести следующий бой забега.
 *
 * Порядок шагов — тот же, что в §3.2, плюс то, чего там не было:
 * состояние ПОСЛЕ боя и награды применяются ОДНОЙ транзакцией вместе
 * с продвижением счётчика боёв. Повторный запрос не найдёт забег
 * в ожидаемом состоянии и не начислит второй раз.
 */
export async function fight(db: Database, profile: PlayerProfile): Promise<FightResult> {
  const row = await requireActive(db, profile.id);
  const zone = requireZone(row.zone);

  if (row.fightIndex >= raid.fightsPerRun) {
    throw new AppError('conflict', {
      messageKey: 'error.run.finished',
      message: 'все бои забега пройдены',
    });
  }

  const loadout = await loadoutOf(db, profile.id);
  const player = fighterFromLoadout(profile, loadout);
  const maxHp = maxHpOf(player, combatBalance);

  const spec = enemyFor(zone, row.fightIndex, row.seed);
  const level = monsterLevel(profile.level, zone, row.difficulty);
  const enemy = monsterFighter(spec, level, zone.power);

  /* HP ПЕРЕНОСИТСЯ между боями (§7.2). Боец входит в бой с текущим
     запасом, а не с полным: без этого «восстанавливается на 25%»
     не значило бы ничего, и риск исчез бы вместе с переносом. */
  const startHp = Math.max(1, Math.min(profile.hpCurrent, maxHp));

  const seed = `${row.seed}:fight:${row.fightIndex}`;
  const { log, outcome } = resolveBattle([{ ...player, startHp }, enemy], combatBalance, seed);

  const won = outcome.winner === 0;
  const nextIndex = row.fightIndex + 1;

  const drops = won ? rollLoot(row, spec, level, nextIndex) : [];
  const rewards = rewardsFor(spec, level, won);

  /* Всё одной транзакцией: исход, HP, XP, золото, лут в сумку
     и счётчик боёв. Счётчик двигается УСЛОВНЫМ обновлением по текущему
     значению — повторный запрос не найдёт строку и не начислит дважды. */
  const applied = await applyFightOutcome(db, {
    runId: row.id,
    playerId: profile.id,
    expectedFightIndex: row.fightIndex,
    won,
    /* Выжил — добираем четверть максимума (§7.2). Погиб — HP обнуляется,
       и следующий забег начнётся с полного: тело и его сумка — это M4. */
    hpAfter: won ? healBetweenFights(outcome.hpRemaining[0], maxHp, zone) : 0,
    xp: rewards.xp,
    // Погибший теряет ПОЛОВИНУ золота боя, но не всё: XP за пройденные
    // бои остаётся целиком (§7.2).
    gold: won ? rewards.gold : Math.floor(rewards.gold * raid.goldKeptOnDeath),
    drops,
    // Пятый бой пройден — забег закончен сам, сумка едет в инвентарь.
    finish: won ? (nextIndex >= raid.fightsPerRun ? 'extracted' : null) : 'wiped',
    opponentRef: `monster:${spec.key}`,
    seed,
    log,
    result: won ? 'win' : 'loss',
    rewardsJson: { xp: rewards.xp, gold: rewards.gold, drops: drops.length },
  });

  const view = await runView(db, { profile: applied.profile, row: applied.run });

  return {
    battleId: applied.battleId,
    log,
    outcome,
    maxHp: [maxHp, maxHpOf(enemy, combatBalance)],
    enemy: spec.key,
    // Силуэт и перекраска — из записи монстра. Клиенту она целиком
    // не отдаётся: ему нужна форма, а не статы.
    enemyLook: { rig: spec.rig, ...(spec.recolor === undefined ? {} : { recolor: spec.recolor }) },
    // Показ считает СЕРВЕР, как и для инвентаря: числа предмета уже
    // с учётом ilvl, и клиент их не выводит (§6.1).
    rewards: { ...rewards, loot: applied.granted.map((item) => toView(item, null)) },
    run: view,
  };
}

/**
 * Доля максимума, возвращаемая между боями. GDD §7.2.
 *
 * ВЕЛИЧИНА ЗОНЫ, а не одна на игру. Общая четверть оставляла свежего
 * изгнанного без первой встречи с решением об эвакуации: до неё
 * доходило 2.8% забегов. Первая зона возвращает половину — она учит,
 * а не отбирает; дальше игрок приходит снаряжённым, и четверть там
 * снова становится ставкой.
 *
 * Зона своего числа не задала — берётся общее из `balance.raid`.
 */
export function restoreFractionOf(zone: ZoneSpec): number {
  return zone.hpRestoreBetweenFights ?? raid.hpRestoreBetweenFights;
}

/** Доля максимума сверху, но не выше самого максимума. GDD §7.2. */
export function healBetweenFights(hp: number, maxHp: number, zone: ZoneSpec): number {
  return Math.min(maxHp, Math.max(1, Math.round(hp + maxHp * restoreFractionOf(zone))));
}

export async function drinkPotion(db: Database, profile: PlayerProfile): Promise<RunView> {
  const row = await requireActive(db, profile.id);
  if (row.potionsLeft <= 0) {
    throw new AppError('conflict', {
      messageKey: 'error.run.noPotions',
      message: 'зелья кончились',
    });
  }

  const loadout = await loadoutOf(db, profile.id);
  const maxHp = maxHpOf(fighterFromLoadout(profile, loadout), combatBalance);
  const healed = Math.min(maxHp, profile.hpCurrent + Math.round(maxHp * raid.potionHealFraction));

  const applied = await spendPotion(db, {
    runId: row.id,
    playerId: profile.id,
    expectedPotions: row.potionsLeft,
    hpAfter: healed,
  });

  return runView(db, { profile: applied.profile, row: applied.run });
}

export async function extract(
  db: Database,
  profile: PlayerProfile,
): Promise<{ run: RunView; recovered: number }> {
  const row = await requireActive(db, profile.id);
  if (!canExtractAt(row.fightIndex)) {
    // Уйти можно после боёв 2, 3 и 4 (§7.2). Не после первого — до первой
    // развилки игрок ничем не рисковал, и уходить не с чем.
    throw new AppError('conflict', {
      messageKey: 'error.run.cannotExtract',
      message: 'эвакуация сейчас недоступна',
    });
  }

  const applied = await extractBag(db, { runId: row.id, playerId: profile.id });
  const view = await runView(db, { profile: applied.profile, row: applied.run });
  return { run: view, recovered: applied.recovered };
}

async function requireActive(db: Database, playerId: string): Promise<RunRow> {
  const row = await findActiveRun(db, playerId);
  if (row === null) {
    throw new AppError('not_found', {
      messageKey: 'error.run.notActive',
      message: 'активного забега нет',
    });
  }
  return row;
}

/* ─────────────────────────────── награды ─────────────────────────────── */

/**
 * XP и золото за бой.
 *
 * Показатель у XP ТОТ ЖЕ, что у кривой уровня (§5.2), и это не совпадение:
 * при одинаковом показателе полный забег даёт постоянную долю уровня
 * на любой глубине. Возьми показатель другим — и прогрессия ускорялась
 * бы или глохла сама по себе.
 */
function rewardsFor(spec: MonsterSpec, level: number, won: boolean): Omit<FightRewards, 'loot'> {
  const bossXp = spec.boss ? rewardsBalance.xpPerFight.bossMultiplier : 1;
  const bossGold = spec.boss ? rewardsBalance.goldPerFight.bossMultiplier : 1;

  const xp = Math.round(
    rewardsBalance.xpPerFight.coefficient * level ** rewardsBalance.xpPerFight.exponent * bossXp,
  );
  const gold = Math.round(
    rewardsBalance.goldPerFight.coefficient *
      level ** rewardsBalance.goldPerFight.exponent *
      bossGold,
  );

  // За проигранный бой XP всё равно начисляется — но половинное золото
  // считает вызывающий: здесь только «сколько стоил бы этот бой».
  void won;
  return { xp, gold };
}

/**
 * Что упало за бой.
 *
 * Ожидаемое ЧИСЛО предметов умножается на глубину и на сложность,
 * а дробный остаток разыгрывается броском: иначе ×1.4 и ×1.8
 * округлялись бы в одно и то же, и три решения из четырёх ничего
 * бы не меняли.
 */
function rollLoot(
  row: RunRow,
  spec: MonsterSpec,
  level: number,
  nextIndex: number,
): readonly Omit<BagItem, 'id'>[] {
  const base = raid.dropsPerFight + (spec.boss ? raid.bossDropBonus : 0);
  const expected =
    base * lootMultiplierAt(nextIndex) * raid.difficulty[row.difficulty].lootMultiplier;

  const whole = Math.floor(expected);
  const fraction = expected - whole;
  const roll = pickRoll(row.seed, 1000 + row.fightIndex);
  const count = whole + (roll < fraction ? 1 : 0);

  const out: Omit<BagItem, 'id'>[] = [];
  for (let i = 0; i < count; i++) {
    const item = generateItem(
      `${row.seed}:loot:${row.fightIndex}:${i}`,
      { ilvl: Math.max(1, level) },
      loot,
      ITEM_BASES,
    );
    /* Лут падает В СУМКУ ЗАБЕГА, а не в инвентарь (§7.2): пока забег
       идёт, предмета в таблице предметов нет вовсе — он лежит в jsonb
       и исчезнет вместе с сумкой, если игрок погибнет. Контейнер
       и замок заполнены заранее: в инвентарь он приедет как обычный
       предмет, и форма меняться не должна. */
    out.push({
      baseKey: item.baseKey,
      slot: item.slot,
      ilvl: item.ilvl,
      rarity: item.rarity,
      // Копия, а не ссылка: генератор отдаёт список только для чтения,
      // а сумка едет в jsonb и обратно, где readonly ничего не значит.
      affixes: [...item.affixes],
      upgradeLevel: 0,
      locked: false,
      container: 'inv',
    });
  }
  return out;
}
