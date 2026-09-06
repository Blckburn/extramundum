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
