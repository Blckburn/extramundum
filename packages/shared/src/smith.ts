import { z } from 'zod';

import type { Materials } from './economy.js';
import type { ItemView } from './items.js';
import type { ProgressionView } from './progression.js';

/**
 * Кузнец. GDD §6.3, §5.2.
 *
 * ГЛАВНЫЙ СТОК ЗОЛОТА, и в v1.0 его не было: кузнец только перекатывал
 * суффиксы, и после тысячи золота деньги было некуда девать.
 *
 * КЛИЕНТ НЕ ПРИСЫЛАЕТ НИ ОДНОГО ЧИСЛА. Ни цены, ни шанса, ни того,
 * во что превратится аффикс: он называет предмет и, для перековки,
 * номер аффикса. Всё остальное сервер читает из базы и считает сам
 * (инвариант 1).
 */

export const smithItemInputSchema = z.object({ itemId: z.uuid() });
export type SmithItemInput = z.infer<typeof smithItemInputSchema>;

/**
 * Перековка одного аффикса. Номер — ИНДЕКС В СПИСКЕ предмета.
 *
 * Индекс, а не семейство: у предмета бывают два аффикса одного
 * семейства, и по семейству было бы не сказать, который из них
 * перековывают.
 */
export const reforgeInputSchema = z.object({
  itemId: z.uuid(),
  affixIndex: z.int().min(0).max(9),
});
export type ReforgeInput = z.infer<typeof reforgeInputSchema>;

export const respecInputSchema = z.object({}).strict();

/** Цена одной операции. Считает сервер, показывает клиент. */
export type SmithCost = {
  readonly gold: number;
  /** Лом и уголь горна — одним набором: платят ими вместе. */
  readonly materials: Materials;
  /** Хватает ли на это прямо сейчас. Считает сервер: запас у него. */
  readonly affordable: boolean;
};

/**
 * Что кузнец может сделать С ЭТИМ предметом, с ценами и рисками.
 *
 * Приходит вместе с предметом, а не считается клиентом: формулы
 * и коэффициенты живут на сервере, а «сколько будет стоить» — первое,
 * что игрок хочет знать до нажатия.
 */
export type SmithOffer = {
  readonly item: ItemView;
  /**
   * Улучшение до следующего уровня. `null` — предмет на потолке.
   *
   * `success` меньше единицы означает риск: при провале теряется один
   * уровень, предмет НЕ ломается (§6.3). Показывается всегда, а не
   * только когда меньше единицы: «риска нет» — тоже сведение.
   */
  readonly upgrade: (SmithCost & { readonly to: number; readonly success: number }) | null;
  readonly reforge: SmithCost | null;
  /** Повышение редкости. `null` — эпик и выше не поднимаются. */
  readonly rarityUp: (SmithCost & { readonly to: string }) | null;
};

export type SmithViewResponse = {
  readonly gold: number;
  readonly materials: Materials;
  /** Предложения по всем предметам инвентаря и стеша. Надетые тоже. */
  readonly offers: readonly SmithOffer[];
  /** Цена респека и можно ли его сейчас сделать. GDD §5.2. */
  readonly respec: SmithCost & { readonly picks: number };
};

/**
 * Итог попытки. `ok: false` — не провал броска, а отказ операции.
 *
 * Провал броска — это `ok: true, succeeded: false`: цена уплачена,
 * уровень потерян, и это ЗАКОННЫЙ исход, а не ошибка. Смешать их
 * значило бы показать игроку «ошибка» там, где он просто не угадал.
 */
export type UpgradeResponse = {
  readonly succeeded: boolean;
  readonly item: ItemView;
  readonly gold: number;
  readonly materials: Materials;
};

export type ReforgeResponse = {
  readonly item: ItemView;
  readonly gold: number;
  readonly materials: Materials;
};

export type RespecResponse = {
  readonly gold: number;
  /** Прогрессия ПОСЛЕ сброса: все драфты снова ждут выбора. */
  readonly progression: ProgressionView;
};

/* ──────────────────────────────── лавка ──────────────────────────────── */

/**
 * Покупка. В теле НОМЕР СЛОТА, и больше ничего.
 *
 * Ни предмета, ни цены: и то, и другое сервер выводит из серверного
 * сида дня заново — как оффер драфта. Прислать «что покупаю» нечем.
 */
export const shopBuyInputSchema = z.object({ slot: z.int().min(0).max(15) });
export type ShopBuyInput = z.infer<typeof shopBuyInputSchema>;

export type ShopSlot = {
  readonly slot: number;
  readonly item: ItemView;
  readonly price: number;
  readonly affordable: boolean;
  /** Уже куплено сегодня. Слот не исчезает: пустая полка — тоже итог. */
  readonly sold: boolean;
};

export type ShopResponse = {
  readonly gold: number;
  readonly slots: readonly ShopSlot[];
  /**
   * Фляги на том же прилавке. GDD §6.3.
   *
   * Не отдельным экраном: и предметы, и заряды покупаются за золото,
   * и держать их врозь значило бы заставлять игрока считать бюджет
   * между двумя экранами.
   */
  readonly flasks: readonly FlaskOffer[];
  /** Вкладки стеша — тот самый сток, который не насыщается. GDD §6.3. */
  readonly stashTabs: StashTabOffer;
  /**
   * Уровень ассортимента — верх САМОГО ГЛУБОКОГО ПРОЙДЕННОГО участка.
   *
   * Показывается, а не подразумевается: иначе «почему тут только
   * ilvl 8» остаётся без ответа, и игрок решает, что лавка сломана.
   */
  readonly level: number;
};

export type ShopBuyResponse = {
  readonly gold: number;
  readonly item: ItemView;
};

/** Что покупается в лавке помимо предметов: заряд фляги. GDD §6.3. */
export const flaskBuyInputSchema = z.object({ tier: z.string().min(1).max(32) });
export type FlaskBuyInput = z.infer<typeof flaskBuyInputSchema>;

export type FlaskBuyResponse = {
  readonly gold: number;
  readonly tier: string;
  readonly charges: number;
};

/** Тир фляги на прилавке: цена, диапазон, побочный эффект, запас. */
export type FlaskOffer = {
  readonly id: string;
  readonly price: number;
  readonly restore: readonly [number, number];
  readonly side: { readonly good: string; readonly bad: string; readonly chance: number } | null;
  readonly charges: number;
  readonly max: number;
  readonly affordable: boolean;
};

/**
 * Покупка вкладки стеша. GDD §6.3.
 *
 * ТЕЛА НЕТ: следующая вкладка одна, и какая именно — сервер знает
 * из числа уже купленных. Принимать номер значило бы дать купить
 * четвёртую, не купив третью, то есть по цене третьей.
 */
export const stashTabInputSchema = z.object({}).strict();

export type StashTabResponse = {
  readonly gold: number;
  readonly owned: number;
  readonly capacity: number;
};

/** Вкладки стеша на прилавке. `price` `null` — все куплены. */
export type StashTabOffer = {
  readonly owned: number;
  readonly price: number | null;
  readonly capacity: number;
  /** Сколько добавит следующая вкладка. */
  readonly slotsPerTab: number;
  readonly affordable: boolean;
};
