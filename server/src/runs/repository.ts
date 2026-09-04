import type { BattleLog, Difficulty, Item, PlayerProfile, ZoneId } from '@extramundum/shared';
import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../db/client.ts';
import { players } from '../db/schema/game.ts';
import { items } from '../db/schema/items.ts';
import { battles, runs, zoneProgress } from '../db/schema/runs.ts';
import { toProfile } from '../players/repository.ts';

/**
 * Доступ к забегам. GDD §7.2, §3.3.
 *
 * ГЛАВНОЕ СВОЙСТВО ЭТОГО ФАЙЛА: каждое изменение забега идёт ОДНОЙ
 * транзакцией и УСЛОВНЫМ обновлением по ожидаемому состоянию. Второй
 * запрос на тот же бой не найдёт строку в нужном состоянии и не сделает
 * ничего — поэтому награду нельзя получить дважды, а смерть нельзя
 * переиграть, даже отправив запрос повторно.
 *
 * Проверять это «по коду вызывающего» было бы бессмысленно: два
 * одновременных запроса проходят проверку оба. Условие обязано стоять
 * в самом UPDATE.
 */

/** Предмет в сумке забега. Идентификатор выдаётся при выпадении. */
export type BagItem = Item;

export type RunRow = {
  readonly id: string;
  readonly playerId: string;
  readonly zone: ZoneId;
  readonly segment: number;
  readonly difficulty: Difficulty;
  readonly fightIndex: number;
  readonly seed: string;
  readonly potionsLeft: number;
  readonly state: 'active' | 'extracted' | 'wiped';
  readonly bag: readonly BagItem[];
};

function toRun(row: typeof runs.$inferSelect): RunRow {
  return {
    id: row.id,
    playerId: row.playerId,
    zone: row.zone,
    segment: row.segment,
    difficulty: row.difficulty,
    fightIndex: row.fightIndex,
    seed: row.seed,
    potionsLeft: row.potionsLeft,
    state: row.state,
    bag: row.bag as readonly BagItem[],
  };
}

export async function findActiveRun(db: Database, playerId: string): Promise<RunRow | null> {
  const rows = await db
    .select()
    .from(runs)
    .where(and(eq(runs.playerId, playerId), eq(runs.state, 'active')))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toRun(row);
}

export async function findRunById(db: Database, id: string): Promise<RunRow | null> {
  const rows = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toRun(row);
}

async function profileById(db: Database, playerId: string): Promise<PlayerProfile> {
  const rows = await db.select().from(players).where(eq(players.id, playerId)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new Error('профиль исчез посреди забега');
  return toProfile(row);
}

/* ──────────────────────────────── старт ──────────────────────────────── */

export async function insertRun(
  db: Database,
  input: {
    playerId: string;
    zone: ZoneId;
    segment: number;
    difficulty: Difficulty;
    seed: string;
    potionsLeft: number;
    /** Полный запас HP на вход. Считает движок — здесь только запись. */
    maxHp: number;
  },
): Promise<{ run: RunRow; profile: PlayerProfile }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(runs)
      .values({
        playerId: input.playerId,
        zone: input.zone,
        segment: input.segment,
        difficulty: input.difficulty,
        seed: input.seed,
        potionsLeft: input.potionsLeft,
      })
      .returning();

    if (row === undefined) throw new Error('забег не создан');

    /* Забег начинается с ПОЛНОГО запаса HP. Между боями восстанавливается
       четверть (§7.2), а на входе — полностью: иначе игрок, погибший
       вчера, сегодня входил бы в зону полумёртвым и без объяснения. */
    const [profile] = await tx
      .update(players)
      .set({ hpCurrent: input.maxHp })
      .where(eq(players.id, input.playerId))
      .returning();

    if (profile === undefined) throw new Error('профиль не найден');
    return { run: toRun(row), profile: toProfile(profile) };
  });
}

/* ─────────────────────────── исход одного боя ────────────────────────── */

export type FightOutcomeInput = {
  readonly runId: string;
  readonly playerId: string;
  /** Номер боя, который ожидался. Основа защиты от двойного начисления. */
  readonly expectedFightIndex: number;
  readonly won: boolean;
  readonly hpAfter: number;
  readonly xp: number;
  readonly gold: number;
  readonly drops: readonly Omit<BagItem, 'id'>[];
  /** Чем кончился забег: `null` — продолжается. */
  readonly finish: 'extracted' | 'wiped' | null;
  readonly opponentRef: string;
  readonly seed: string;
  readonly log: BattleLog;
  readonly result: 'win' | 'loss';
  readonly rewardsJson: Record<string, number>;
  /**
   * Участок, который этот бой закрывает. `null` — не закрывает.
   *
   * Записывается ТОЙ ЖЕ транзакцией, что и сам бой. Отдельным запросом
   * нельзя по той же причине, по которой нельзя стирать сумку: между
   * двумя запросами игрок успел бы уйти, и участок засчитался бы
   * за бой, награду за который он не получил.
   */
  readonly clears: { readonly zone: ZoneId; readonly segment: number } | null;
};

export type FightOutcomeResult = {
  readonly battleId: string;
  readonly run: RunRow;
  readonly profile: PlayerProfile;
  /** Что упало ЭТИМ боем, уже с идентификаторами. */
  readonly granted: readonly BagItem[];
};

/**
 * Записать бой и применить его последствия. GDD §3.2 шаг 5, §7.2.
 *
 * ОДНОЙ ТРАНЗАКЦИЕЙ: журнал боя, HP, XP, золото, сумка и счётчик боёв.
 * Счётчик двигается условием `fight_index = ожидаемый AND state = active`,
 * и это единственное, что стоит между игроком и повторным начислением:
 * повторный запрос не найдёт строку и вернёт отказ, а не вторую награду.
 *
 * При смерти сумка стирается ЗДЕСЬ ЖЕ. Отдельным запросом её стирать
 * нельзя: между двумя запросами игрок успел бы эвакуироваться.
 */
export async function applyFightOutcome(
  db: Database,
  input: FightOutcomeInput,
): Promise<FightOutcomeResult> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, input.runId))
      .limit(1)
      .then((rows) => rows[0]);
    if (current === undefined) throw new Error('забег исчез');

    const granted: BagItem[] = input.drops.map((drop) => ({
      ...drop,
      // Идентификатор выдаётся ПРИ ВЫПАДЕНИИ, а не при эвакуации:
      // игрок видит предмет в сумке под тем же номером, под которым
      // тот приедет в инвентарь.
      id: crypto.randomUUID(),
    }));

    const bag = input.won ? [...(current.bag as BagItem[]), ...granted] : [];
    const nextIndex = input.expectedFightIndex + 1;

    const [row] = await tx
      .update(runs)
      .set({
        fightIndex: nextIndex,
        bag,
        state: input.finish ?? 'active',
        ...(input.finish === null ? {} : { finishedAt: new Date() }),
      })
      .where(
        and(
          eq(runs.id, input.runId),
          eq(runs.state, 'active'),
          // ВОТ ЭТО УСЛОВИЕ и есть защита от двойного начисления.
          eq(runs.fightIndex, input.expectedFightIndex),
        ),
      )
      .returning();

    if (row === undefined) {
      // Значит бой уже проведён другим запросом. Ничего не начислено —
      // транзакция откатится целиком.
      throw new Error('забег изменился между чтением и записью');
    }

    const [battle] = await tx
      .insert(battles)
      .values({
        playerId: input.playerId,
        runId: input.runId,
        opponentRef: input.opponentRef,
        seed: input.seed,
        log: input.log,
        result: input.result,
        rewards: input.rewardsJson,
        // Награды применены по-настоящему — пометка эпохи M2b снята.
        provisional: false,
      })
      .returning({ id: battles.id });

    if (battle === undefined) throw new Error('бой не записан');

    const [profile] = await tx
      .update(players)
      .set({
        hpCurrent: input.hpAfter,
        xp: sql`${players.xp} + ${input.xp}`,
        gold: sql`${players.gold} + ${input.gold}`,
      })
      .where(eq(players.id, input.playerId))
      .returning();

    if (profile === undefined) throw new Error('профиль не найден');

    /* УЧАСТОК ЗАСЧИТЫВАЕТСЯ ТУТ ЖЕ. Хранится максимум достигнутого,
       поэтому повторное прохождение того же участка ничего не меняет,
       а `greatest` не даёт откатить прогресс назад более ранним
       участком — при повторе первого после четвёртого. */
    if (input.clears !== null) {
      const reached = input.clears.segment + 1;
      await tx
        .insert(zoneProgress)
        .values({ playerId: input.playerId, zone: input.clears.zone, cleared: reached })
        .onConflictDoUpdate({
          target: [zoneProgress.playerId, zoneProgress.zone],
          set: { cleared: sql`greatest(${zoneProgress.cleared}, ${reached})` },
        });
    }

    /* Забег закончился ПОБЕДОЙ в пятом бою — сумка едет в инвентарь
       той же транзакцией. Отдельным запросом это было бы окном, в котором
       забег уже закончен, а лут ещё нигде. */
    if (input.finish === 'extracted' && bag.length > 0) {
      await insertBag(tx, input.playerId, bag);
      await tx.update(runs).set({ bag: [] }).where(eq(runs.id, input.runId));
    }

    return {
      battleId: battle.id,
      run: { ...toRun(row), bag: input.finish === 'extracted' ? [] : bag },
      profile: toProfile(profile),
      granted,
    };
  });
}

/* ───────────────────────────────── зелье ─────────────────────────────── */

export async function spendPotion(
  db: Database,
  input: { runId: string; playerId: string; expectedPotions: number; hpAfter: number },
): Promise<{ run: RunRow; profile: PlayerProfile }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(runs)
      .set({ potionsLeft: input.expectedPotions - 1 })
      .where(
        and(
          eq(runs.id, input.runId),
          eq(runs.state, 'active'),
          // То же условие, что у боя: два одновременных «выпить» не должны
          // вылечить дважды за один заряд.
          eq(runs.potionsLeft, input.expectedPotions),
        ),
      )
      .returning();

    if (row === undefined) throw new Error('заряд уже потрачен');

    const [profile] = await tx
      .update(players)
      .set({ hpCurrent: input.hpAfter })
      .where(eq(players.id, input.playerId))
      .returning();

    if (profile === undefined) throw new Error('профиль не найден');
    return { run: toRun(row), profile: toProfile(profile) };
  });
}

/* ────────────────────────────── эвакуация ────────────────────────────── */

export async function extractBag(
  db: Database,
  input: { runId: string; playerId: string },
): Promise<{ run: RunRow; profile: PlayerProfile; recovered: number }> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(runs)
      .where(and(eq(runs.id, input.runId), eq(runs.state, 'active')))
      .limit(1)
      .then((rows) => rows[0]);
    if (current === undefined) throw new Error('активного забега нет');

    const bag = current.bag as BagItem[];

    const [row] = await tx
      .update(runs)
      .set({ state: 'extracted', bag: [], finishedAt: new Date() })
      .where(and(eq(runs.id, input.runId), eq(runs.state, 'active')))
      .returning();

    if (row === undefined) throw new Error('забег уже завершён');
    if (bag.length > 0) await insertBag(tx, input.playerId, bag);

    return {
      run: toRun(row),
      profile: await profileById(tx as unknown as Database, input.playerId),
      recovered: bag.length,
    };
  });
}

/**
 * Сумка в инвентарь. Идентификаторы СОХРАНЯЮТСЯ теми же, что были
 * в сумке: игрок видел предмет под этим номером, и менять его
 * при переезде незачем.
 */
async function insertBag(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  playerId: string,
  bag: readonly BagItem[],
): Promise<void> {
  await tx.insert(items).values(
    bag.map((item) => ({
      id: item.id,
      ownerId: playerId,
      baseKey: item.baseKey,
      ilvl: item.ilvl,
      rarity: item.rarity,
      affixes: item.affixes,
      container: 'inv' as const,
    })),
  );
}

/* ───────────────────────── прогресс по участкам ──────────────────────── */

/**
 * Сколько участков пройдено в каждой зоне.
 *
 * Отдаётся картой «зона → число», а не строками: потребителю нужен
 * ответ «открыт ли участок», и этой формы для него достаточно.
 * Незаписанная зона — ноль, а не отсутствие: отсутствие пришлось бы
 * обрабатывать в каждом месте отдельно.
 */
export async function readZoneProgress(
  db: Database,
  playerId: string,
): Promise<Readonly<Record<string, number>>> {
  const rows = await db
    .select({ zone: zoneProgress.zone, cleared: zoneProgress.cleared })
    .from(zoneProgress)
    .where(eq(zoneProgress.playerId, playerId));

  const out: Record<string, number> = {};
  for (const row of rows) out[row.zone] = row.cleared;
  return out;
}
