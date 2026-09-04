import { balance as balanceData, ITEM_BASES } from '@extramundum/data';
import { monsterSpec, ZONES } from '@extramundum/data/zones';
import {
  enemyLevel,
  isSegmentUnlocked,
  lootBalanceSchema,
  rarityWeightsFor,
  seededRoll,
  segmentBounds,
  type Difficulty,
  type FightRewards,
  type MonsterSpec,
  type NextEnemy,
  type RunSummary,
  type RunView,
  type ZoneSpec,
} from '@extramundum/shared';
import { generateItem, matchupMultiplier, maxHp as maxHpOf, resolveBattle } from '@extramundum/sim';
import { randomUUID } from 'node:crypto';

import { combatBalance } from '../battle/setup.ts';
import {
  isBossFight,
  monsterFighter,
  monsterPower,
  requireZone,
  zoneLootMultiplier,
} from '../battle/monsters.ts';
import type { Database } from '../db/client.ts';
import { AppError } from '../http/errors.ts';
import { fighterFromLoadout, toView } from '../items/loadout.ts';
import { loadoutOf } from '../items/repository.ts';
import { progressionOf } from '../progression/service.ts';
import type { PlayerProfile } from '@extramundum/shared';

import {
  applyFightOutcome,
  extractBag,
  findActiveRun,
  insertRun,
  readZoneProgress,
  runTotals,
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
 * Бросок, выбирающий монстра для боя, и он же — на дробный остаток лута.
 *
 * Выводится из сида забега и номера боя, а не из общего генератора:
 * тогда «кто следующий» не зависит от того, сколько раз игрок обновил
 * экран, и совпадает с тем, что было показано в превью.
 *
 * ХЕШ ОБЩИЙ С ОФФЕРОМ ДРАФТА (`seededRoll` в shared), и это исправление
 * аварии, а не уборка. Здесь стоял тот же приём, скопированный руками
 * и БЕЗ ЛАВИНЫ: номера боёв 0..3 различаются последним символом ключа,
 * поэтому четыре броска были почти одним. Замерено: 96.7% забегов шли
 * против одного и того же монстра все четыре боя.
 */
function pickRoll(seed: string, fightIndex: number): number {
  return seededRoll(`${seed}:enemy:${fightIndex}`);
}

/**
 * Уровень врага в бою с данным номером. ОТ УЧАСТКА, не от игрока.
 *
 * Внутри участка уровень разыгрывается СВОИМ броском, а не тем же,
 * что выбирает монстра: один бросок связал бы «кто вышел» с «какого
 * он уровня», и половина монстров зоны встречалась бы только на своём
 * конце диапазона. Это та же ошибка, что общий бросок на уклонение
 * и блок (пункт 5 аудита v1.0), только в другом месте.
 *
 * Ключ отличается словом, а не цифрой: `seededRoll` лавинный, но
 * различать потоки соседним символом — привычка, которая однажды уже
 * стоила аварии.
 */
export function levelFor(
  zone: ZoneSpec,
  fightIndex: number,
  segment: number,
  seed: string,
): number {
  return enemyLevel(
    zone,
    segment,
    seededRoll(`${seed}:level:${fightIndex}`),
    isBossFight(fightIndex),
  );
}

/** Кто ждёт в бою с данным номером. */
export function enemyFor(zone: ZoneSpec, fightIndex: number, seed: string): MonsterSpec {
  if (isBossFight(fightIndex)) return monsterSpec(zone.boss);

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
  const player = fighterFromLoadout(profile, loadout, await progressionOf(db, profile));
  const maxHp = maxHpOf(player, combatBalance);

  const finished = row.state !== 'active' || row.fightIndex >= raid.fightsPerRun;
  const next = finished ? null : nextEnemy(zone, row, player.weapon.class);

  // Сумка показывается целиком: «содержимое сумки игроку известно,
  // он видел, как падал лут» (§7.2). Предметы в ней уже с номерами —
  // теми же, под которыми приедут в инвентарь.
  const bag = row.bag.map((item) => toView(item, null));

  return {
    runId: row.id,
    zone: row.zone,
    segment: row.segment,
    segmentLevels: segmentBounds(zone, row.segment),
    difficulty: row.difficulty,
    state: row.state,
    fightIndex: row.fightIndex,
    fightsTotal: raid.fightsPerRun,
    hp: Math.min(profile.hpCurrent, maxHp),
    maxHp,
    potionsLeft: row.potionsLeft,
    bag,
    lootMultiplier: lootMultiplierAt(row.fightIndex),
    hpRestore: restoreFractionOf(zone),
    next,
    canExtract: row.state === 'active' && canExtractAt(row.fightIndex),
  };
}

function nextEnemy(zone: ZoneSpec, row: RunRow, playerWeapon: NextEnemy['weaponClass']): NextEnemy {
  const spec = enemyFor(zone, row.fightIndex, row.seed);
  return {
    key: spec.key,
    level: levelFor(zone, row.fightIndex, row.segment, row.seed),
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
  input: { zone: RunRow['zone']; segment: number; difficulty: Difficulty },
): Promise<RunView> {
  // Зона, которой ещё нет (`rift` отложен до M4), — отказ, а не бой
  // без противника.
  const zone = requireZone(input.zone);

  /* ЗАПЕРТЫЙ УЧАСТОК — ОТКАЗ, и отказывает СЕРВЕР.

     Замок на карточке обходится одним запросом мимо интерфейса,
     поэтому `isSegmentUnlocked` стоит и там, и здесь — одна функция
     на оба места, как всё остальное про уровень.

     Проверка теперь смотрит на ПРОХОЖДЕНИЕ, а не на уровень игрока.
     Прежний замок по уровню существовал затем, чтобы переросший игрок
     не фармил «Кошмар» в первой зоне за полную цену: уровень врага
     ехал за игроком и упирался в потолок зоны. Он больше не едет,
     и замок по уровню остался бы без причины. */
  const progress = await readZoneProgress(db, profile.id);
  if (!isSegmentUnlocked(ZONES, progress, zone.id, input.segment)) {
    throw new AppError('forbidden', {
      messageKey: 'error.run.segmentLocked',
      message: `участок ${input.segment + 1} зоны «${zone.id}» ещё не открыт`,
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
  const maxHp = maxHpOf(
    fighterFromLoadout(profile, loadout, await progressionOf(db, profile)),
    combatBalance,
  );

  const row = await insertRun(db, {
    playerId: profile.id,
    zone: zone.id,
    segment: input.segment,
    difficulty: input.difficulty,
    seed: randomUUID(),
    potionsLeft: raid.potionChargesPerRun,
    maxHp,
  });

  return runView(db, { profile: row.profile, row: row.run });
}

/**
 * ИТОГ ЗАБЕГА. GDD §7.2.
 *
 * Числа берутся из ЖУРНАЛА БОЁВ, а не складываются по ходу: журнал
 * пишется каждым боем и так, а вторая копия тех же сумм — второе
 * место, где они разойдутся.
 *
 * Собирается ПОСЛЕ транзакции, но сумка приходит аргументом: в строке
 * забега её уже нет, а в инвентаре предметы смешались с прежними.
 */
async function summaryOf(
  db: Database,
  row: RunRow,
  state: Exclude<RunSummary['state'], never>,
  hauled: readonly BagItem[],
): Promise<RunSummary> {
  const zone = requireZone(row.zone);
  const totals = await runTotals(db, row.id);
  return {
    zone: row.zone,
    segment: row.segment,
    segmentLevels: segmentBounds(zone, row.segment),
    difficulty: row.difficulty,
    state,
    fightsCleared: totals.fightsCleared,
    // Босс — пятый бой, и убит он только если пройдены все пять.
    bossKilled: totals.fightsCleared >= raid.fightsPerRun,
    xp: totals.xp,
    gold: totals.gold,
    loot: hauled.map((item) => toView(item, null)),
  };
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
  readonly summary: RunSummary | null;
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
  /* Карты драфта и трейты пятых уровней входят в бойца ЗДЕСЬ, а не
     где-то ещё: боец боя и боец превью собираются одной функцией
     и одной прогрессией, иначе превью обещало бы одно, а бой давал
     другое. */
  const player = fighterFromLoadout(profile, loadout, await progressionOf(db, profile));
  const maxHp = maxHpOf(player, combatBalance);

  const spec = enemyFor(zone, row.fightIndex, row.seed);
  const level = levelFor(zone, row.fightIndex, row.segment, row.seed);
  const enemy = monsterFighter(spec, level, monsterPower(zone, row.segment, row.difficulty));

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
    /* УЧАСТОК ЗАСЧИТЫВАЕТСЯ ЗА УБИТОГО БОССА, то есть за пятый бой.
       Не за эвакуацию: уйти с добычей — это отказ от риска, и открывать
       им следующий участок значило бы платить продвижением за отказ. */
    clears: won && isBossFight(row.fightIndex) ? { zone: zone.id, segment: row.segment } : null,
  });

  const view = await runView(db, { profile: applied.profile, row: applied.run });

  /* Итог собирается ТОЛЬКО когда забег кончился этим боем. Показывать
     его раньше значило бы объявить исход посреди забега — та же
     ошибка, что панель наград над ещё не досмотренным боем. */
  const summary =
    applied.hauled === null
      ? null
      : await summaryOf(
          db,
          applied.run,
          applied.run.state === 'wiped' ? 'wiped' : 'extracted',
          applied.hauled,
        );

  return {
    battleId: applied.battleId,
    summary,
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
  const maxHp = maxHpOf(
    fighterFromLoadout(profile, loadout, await progressionOf(db, profile)),
    combatBalance,
  );
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
): Promise<{ run: RunView; recovered: number; summary: RunSummary }> {
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
  return {
    run: view,
    recovered: applied.recovered,
    // Уход — тоже конец забега, и итог у него тот же самый.
    summary: await summaryOf(db, applied.run, 'extracted', applied.hauled),
  };
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
 *
 * УРОВНЯ ИГРОКА ЗДЕСЬ БОЛЬШЕ НЕТ. Прежде оплата тира умножалась на долю
 * уцелевшей разницы уровней игрока и врага — компенсация того, что
 * уровень врага упирался в потолок зоны. Уровень врага приходит
 * из участка и от игрока не зависит, так что компенсировать нечего.
 */
function rollLoot(
  row: RunRow,
  spec: MonsterSpec,
  level: number,
  nextIndex: number,
): readonly Omit<BagItem, 'id'>[] {
  const base = raid.dropsPerFight + (spec.boss ? raid.bossDropBonus : 0);
  const expected = base * lootMultiplierAt(nextIndex) * zoneLootMultiplier(row.difficulty);

  const whole = Math.floor(expected);
  const fraction = expected - whole;
  const roll = pickRoll(row.seed, 1000 + row.fightIndex);
  const count = whole + (roll < fraction ? 1 : 0);

  const out: Omit<BagItem, 'id'>[] = [];
  for (let i = 0; i < count; i++) {
    /* ДВЕ ОСИ: УРОВЕНЬ ОТ УЧАСТКА, РЕДКОСТЬ ОТ СЛОЖНОСТИ. Участок
       решает, какого уровня вещь; сложность — какого она сорта. Пока
       это была одна ось, игрок в эпиках ilvl 2 не мог ни получить эпик
       ilvl 8, ни захотеть обычный ilvl 8 (PLAYTEST 2026-09-04).

       Веса считает общая функция из `shared` — та же, которой
       пользуется замер плотности, иначе замер мерил бы не то, что
       получает игрок. */
    const item = generateItem(
      `${row.seed}:loot:${row.fightIndex}:${i}`,
      {
        ilvl: Math.max(1, level),
        rarityWeights: rarityWeightsFor(row.difficulty, spec.boss, loot.drop),
      },
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
