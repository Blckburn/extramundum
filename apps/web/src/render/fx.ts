import type { AnimationStage } from '@extramundum/shared';
import { PointLight, type Object3D, type Vector3 } from 'three';

import { paletteHex } from './palette.js';
import type { BuiltRig } from './rig.js';

/**
 * Эффекты на бойце: выпад, тряска, вспышка. GDD §3.4, §13 пункт 20.
 *
 * Каждый вид эффекта существует в ОДНОМ экземпляре на бойца, и повторное
 * срабатывание перезапускает его, а не добавляет второй. Так и должно
 * быть: два выпада одновременно — это не «вдвое сильнее», это боец
 * в двух местах сразу.
 *
 * Отсюда важное следствие для памяти: пул здесь не нужен, потому что
 * нечего пулить — набор слотов фиксирован размером сцены. Аллокаций
 * в кадре нет ни одной, все векторы и источники света заведены заранее.
 *
 * Время берётся ИЗ ЧАСОВ ВОСПРОИЗВЕДЕНИЯ, а не накапливается из dt.
 * Иначе пауза и перемотка потребовали бы отдельной бухгалтерии: при
 * общих часах поставленный на паузу выпад просто застывает, а прокрутка
 * назад отменяет его тем же сравнением, что и любое другое событие.
 */

type Track = {
  /** Момент запуска по часам воспроизведения. Отрицательный — выключен. */
  startMs: number;
  durationMs: number;
  amount: number;
};

const idleTrack = (): Track => ({ startMs: -1, durationMs: 1, amount: 0 });

export class FighterFx {
  private readonly rig: BuiltRig;
  private readonly stage: AnimationStage;
  /** Куда смотрит выпад: +1 вправо, −1 влево. Из позиции, а не из индекса. */
  private readonly facing: number;
  private readonly baseX: number;
  private readonly light: PointLight;
  private readonly lunge = idleTrack();
  private readonly shake = idleTrack();
  private readonly flash = idleTrack();
  private readonly topple = idleTrack();
  private readonly numberAnchor: Object3D;
  private readonly burstAnchor: Object3D;

  constructor(rig: BuiltRig, stage: AnimationStage, facing: number) {
    this.rig = rig;
    this.stage = stage;
    this.facing = facing;
    this.baseX = rig.root.position.x;

    // Вспышка меняет СВЕТ, а не материал: материалы общие на всю сцену,
    // и покрасить один означало бы покрасить всех бойцов разом. Ровно
    // та же причина, по которой в M2a мерцает жаровня, а не её материал.
    this.light = new PointLight(paletteHex('bone'), 0, stage.flashDistance);
    this.light.position.set(0, stage.flashHeightM, 0);
    rig.root.add(this.light);

    const number = rig.nodes.get(stage.numberAnchor);
    const burst = rig.nodes.get(stage.burstAnchor);
    if (number === undefined || burst === undefined) {
      // Якорь из данных, которого нет в риге, — ошибка данных. Молча
      // взять корень значило бы, что числа всплывают из-под ног,
      // и никто не поймёт почему.
      throw new Error(
        `нет узла «${number === undefined ? stage.numberAnchor : stage.burstAnchor}» в риге «${rig.root.name}»`,
      );
    }
    this.numberAnchor = number;
    this.burstAnchor = burst;
  }

  /** Мировая точка над головой. Пишет в переданный вектор, не аллоцирует. */
  numberPoint(into: Vector3): Vector3 {
    return this.numberAnchor.getWorldPosition(into);
  }

  burstPoint(into: Vector3): Vector3 {
    return this.burstAnchor.getWorldPosition(into);
  }

  startLunge(nowMs: number, durationMs: number, amount: number): void {
    this.lunge.startMs = nowMs;
    this.lunge.durationMs = durationMs;
    this.lunge.amount = amount;
  }

  startShake(nowMs: number, durationMs: number, amount: number): void {
    this.shake.startMs = nowMs;
    this.shake.durationMs = durationMs;
    this.shake.amount = amount;
  }

  /**
   * Падение. Единственный трек, который ОСТАЁТСЯ в конечном положении:
   * убитый боец не поднимается обратно, а обычная развёртка трека
   * возвращает всё к покою.
   */
  startTopple(nowMs: number, durationMs: number, amount: number): void {
    this.topple.startMs = nowMs;
    this.topple.durationMs = durationMs;
    this.topple.amount = amount;
  }

  startFlash(nowMs: number, durationMs: number, amount: number, colorKey: string): void {
    this.flash.startMs = nowMs;
    this.flash.durationMs = durationMs;
    this.flash.amount = amount;
    // `setHex`, а не `set(строка)`: разбор строки аллоцирует, а вспышка
    // случается на каждом ударе (palette.ts).
    this.light.color.setHex(paletteHex(colorKey));
  }

  /** Сбросить всё: перемотка не оставляет позы от будущего. */
  reset(): void {
    this.lunge.startMs = -1;
    this.shake.startMs = -1;
    this.flash.startMs = -1;
    this.topple.startMs = -1;
    this.rig.root.position.x = this.baseX;
    this.rig.root.rotation.z = 0;
    this.light.intensity = 0;
  }

  /**
   * Один кадр. Ни `new`, ни литералов, ни `for...of` — правило M2a
   * действует и во время боя, иначе замер аллокаций проверял бы
   * только статичную сцену.
   */
  update(nowMs: number): void {
    let offset = 0;

    const lungeT = progress(this.lunge, nowMs);
    // Туда и обратно одной синусоидой: удар без возврата оставил бы
    // бойца стоять в чужой половине арены.
    if (lungeT >= 0) offset += Math.sin(Math.PI * lungeT) * this.lunge.amount * this.facing;

    const shakeT = progress(this.shake, nowMs);
    if (shakeT >= 0) {
      const decay = 1 - shakeT;
      offset +=
        Math.sin(shakeT * (this.shake.durationMs / 1000) * this.stage.shakeHz * Math.PI * 2) *
        this.shake.amount *
        decay;
    }

    this.rig.root.position.x = this.baseX + offset;

    const flashT = progress(this.flash, nowMs);
    this.light.intensity =
      flashT < 0 ? 0 : this.stage.flashIntensity * this.flash.amount * (1 - flashT);

    // Падение считается СВОЕЙ развёрткой: обычная гасит эффект после
    // конца, а упавший обязан остаться лежать. Перемотка назад его
    // при этом отменяет — тем же сравнением с началом.
    const toppleT = holdProgress(this.topple, nowMs);
    // Направление — от противника: боец валится наружу, а не в него.
    this.rig.root.rotation.z =
      toppleT < 0 ? 0 : easeOut(toppleT) * this.topple.amount * -this.facing;
  }
}

/**
 * Доля прожитого, 0..1. Возвращает −1, если трек выключен или истёк.
 *
 * Прокрутка НАЗАД гасит эффект тем же сравнением: `nowMs` меньше начала —
 * значит эффект ещё не случился.
 */
function progress(track: Track, nowMs: number): number {
  if (track.startMs < 0 || nowMs < track.startMs) return -1;
  const t = (nowMs - track.startMs) / track.durationMs;
  return t >= 1 ? -1 : t;
}

/**
 * То же, но после конца остаётся единицей: эффект доигрывает и ЗАСТЫВАЕТ.
 *
 * Перемотка назад по-прежнему его отменяет — сравнением с началом,
 * а не с концом. Иначе труп оставался бы лежать при отмотке в середину
 * боя, где он ещё жив.
 */
function holdProgress(track: Track, nowMs: number): number {
  if (track.startMs < 0 || nowMs < track.startMs) return -1;
  return Math.min(1, (nowMs - track.startMs) / track.durationMs);
}

/** Замедление к концу: падение начинается резко и укладывается мягко. */
function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}
