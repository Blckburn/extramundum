import {
  flaskPrice,
  flaskRestore,
  seededRoll,
  type EconomyBalance,
  type StatusId,
} from '@extramundum/shared';
import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../db/client.ts';
import { players } from '../db/schema/game.ts';
import { playerFlasks } from '../db/schema/items.ts';
import { AppError } from '../http/errors.ts';

import { economy } from './prices.ts';

/**
 * Фляги. GDD §7.2, §6.3.
 *
 * ЗАРЯДОВ ПО УМОЛЧАНИЮ НОЛЬ (решение человека). Первый забег без золота
 * обязан быть возможен, и «идти без фляг» — это он и есть. Бесплатный
 * заряд вводил бы новое правило вместо снятого: его пришлось бы
 * восстанавливать по таймеру или за забег.
 *
 * ВОССТАНОВЛЕНИЕ — БРОСОК В ДИАПАЗОНЕ, а не фиксированная доля.
 * Выпавшее игрок видит ДО решения об эвакуации, поэтому случайность
 * работает НА решение, а не против него: «дотяну ли я до пятого боя»
 * становится вопросом с новым ответом, а не арифметикой.
 */

export type FlaskTier = EconomyBalance['flasks']['tiers'][number];

export function tierOf(id: string): FlaskTier {
  const tier = economy.flasks.tiers.find((t) => t.id === id);
  if (tier === undefined) {
    throw new AppError('not_found', {
      messageKey: 'error.flask.unknown',
      message: `фляги «${id}» не существует`,
    });
  }
  return tier;
}

export type FlaskStock = Readonly<Record<string, number>>;

export async function readFlasks(db: Database, playerId: string): Promise<FlaskStock> {
  const rows = await db
    .select({ tier: playerFlasks.tier, charges: playerFlasks.charges })
    .from(playerFlasks)
    .where(eq(playerFlasks.playerId, playerId));

  const out: Record<string, number> = {};
  for (const row of rows) out[row.tier] = row.charges;
  return out;
}

/**
 * Купить один заряд. GDD §6.3: «пополнение зелий — сток на каждом забеге».
 *
 * ПОТОЛОК ЗАРЯДОВ ПРОВЕРЯЕТСЯ В САМОМ UPDATE, а не до него: два
 * одновременных запроса прошли бы проверку «меньше максимума» оба.
 * То же правило, что у двойного начисления за бой.
 */
export async function buyFlask(
  db: Database,
  playerId: string,
  tierId: string,
  level: number,
): Promise<{ gold: number; charges: number }> {
  const tier = tierOf(tierId);
  /* ЦЕНА ОТ ГЛУБИНЫ ПРОЙДЕННОГО, а не постоянная и не от уровня
     игрока: фляга возвращает ДОЛЮ максимума, значит её польза растёт
     вместе с игроком. Глубина берётся та же, что у ассортимента
     лавки, — правило одно на всю игру. */
  const price = flaskPrice(tier.id, economy, level);
  const max = economy.flasks.maxCharges;

  return db.transaction(async (tx) => {
    const charges = await grantFlask(tx, playerId, tier.id, max);
    if (charges === null) {
      throw new AppError('conflict', {
        messageKey: 'error.flask.full',
        message: 'больше зарядов этого тира не унести',
      });
    }

    const [row] = await tx
      .update(players)
      .set({ gold: sql`${players.gold} - ${price}` })
      .where(and(eq(players.id, playerId), sql`${players.gold} >= ${price}`))
      .returning({ gold: players.gold });

    if (row === undefined) {
      throw new AppError('conflict', {
        messageKey: 'error.shop.noGold',
        message: 'не хватает золота',
      });
    }

    return { gold: row.gold, charges };
  });
}

/**
 * Прибавить один заряд. `null` — уже полный запас, ничего не тронуто.
 *
 * ПОТОЛОК ПРОВЕРЯЕТСЯ В САМОМ UPDATE (`setWhere`), а не до него: два
 * одновременных запроса прошли бы проверку «меньше максимума» оба.
 * То же правило, что у двойного начисления за бой.
 */
export async function grantFlask(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  playerId: string,
  tierId: string,
  max: number = economy.flasks.maxCharges,
): Promise<number | null> {
  const rows = await tx
    .insert(playerFlasks)
    .values({ playerId, tier: tierId, charges: 1 })
    .onConflictDoUpdate({
      target: [playerFlasks.playerId, playerFlasks.tier],
      set: { charges: sql`${playerFlasks.charges} + 1` },
      setWhere: sql`${playerFlasks.charges} < ${max}`,
    })
    .returning({ charges: playerFlasks.charges });
  return rows[0]?.charges ?? null;
}

/** Что даст глоток: доля максимума и побочный эффект, если он выпал. */
export type Sip = {
  readonly fraction: number;
  readonly status: {
    readonly id: StatusId;
    readonly stacks: number;
    readonly duration: number;
  } | null;
};

/**
 * Бросок фляги. Детерминирован от сида забега и номера глотка.
 *
 * ДВА РАЗНЫХ БРОСКА, а не один: сколько восстановлено и какой стороной
 * лёг побочный эффект — величины, которые игрок читает по отдельности,
 * и общий бросок связал бы их парой. Это тот же пункт 5 аудита v1.0,
 * что и общий бросок на уклонение с блоком.
 */
export function sipOf(tierId: string, runSeed: string, drunk: number): Sip {
  const tier = tierOf(tierId);
  const key = `${runSeed}:flask:${String(drunk)}`;
  const fraction = flaskRestore(tier.id, seededRoll(`${key}:restore`), economy);

  if (tier.side === null) return { fraction, status: null };

  const side = tier.side;
  const rolled = seededRoll(`${key}:side`);
  if (rolled >= side.chance * 2) return { fraction, status: null };

  /* ОБЕ СТОРОНЫ РАВНОВЕРОЯТНЫ внутри своей доли: `chance` — шанс
     хорошего исхода, столько же у плохого, остальное — ничего.
     Иначе «побочный эффект в обе стороны» из §7.2 означал бы только
     одну сторону, и верхний тир был бы просто лучшим. */
  const good = rolled < side.chance;
  return {
    fraction,
    status: {
      id: good ? side.good : side.bad,
      stacks: side.stacks,
      duration: side.duration,
    },
  };
}

/**
 * Списать заряд. Возвращает `false`, не тронув ничего, если его нет.
 *
 * Условие в самом UPDATE, как у материалов: проверку «есть ли заряд»
 * до него прошли бы два одновременных запроса.
 */
export async function spendFlask(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  playerId: string,
  tierId: string,
): Promise<boolean> {
  const changed = await tx
    .update(playerFlasks)
    .set({ charges: sql`${playerFlasks.charges} - 1` })
    .where(
      and(
        eq(playerFlasks.playerId, playerId),
        eq(playerFlasks.tier, tierId),
        sql`${playerFlasks.charges} >= 1`,
      ),
    )
    .returning({ tier: playerFlasks.tier });
  return changed.length > 0;
}

export { economy };
