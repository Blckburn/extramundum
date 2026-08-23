import { animations } from '@extramundum/data';
import type { ActorIndex, AnimationSpec, BattleEvent, BattleLog } from '@extramundum/shared';
import { Vector3 } from 'three';

import { FighterFx } from '../render/fx.js';
import { FloatingNumbers } from '../render/numbers.js';
import { ParticleField } from '../render/particles.js';
import type { BattleScene } from '../render/scene.js';

import {
  endOfIndex,
  persistentStepsBefore,
  schedule,
  shownCount,
  stepCursorAt,
  timeline,
  type Schedule,
  type TimedStep,
} from './schedule.js';

/**
 * Проигрыватель боя. GDD §3.2, §10.
 *
 * Клиент НЕ СЧИТАЕТ НИЧЕГО. Ни урона, ни шансов, ни исхода: всё это уже
 * посчитано движком на сервере и лежит в логе. Здесь только раскладка
 * готовых событий по времени и вызов примитивов. Это и есть граница
 * инварианта 3 в человеческом виде: проигрыватель может ошибиться
 * в анимации, но не может ошибиться в бою.
 *
 * Три вещи держат перемотку честной:
 *
 *  1. **Состояние — свёртка префикса лога** (state.ts), а не накопление.
 *     Прокрутка назад пересчитывает с начала и потому точна.
 *  2. **Часы одни на всё.** Эффекты сравнивают свой момент запуска
 *     с часами воспроизведения; пауза их замораживает, перемотка назад
 *     гасит тем же сравнением.
 *  3. **Примитивы разложены заранее** в плоский список по времени.
 *     Скорость — множитель хода часов, а не другое расписание.
 */

export type PlayerOptions = {
  readonly scene: BattleScene;
  readonly log: BattleLog;
  /**
   * Текст всплывающего числа. Приходит СНАРУЖИ, потому что это
   * локализованная строка (инвариант 6), а проигрыватель обязан
   * оставаться проверяемым без словарей.
   */
  readonly numberText: (event: BattleEvent) => string | null;
  readonly spec?: AnimationSpec;
};

export class BattlePlayer {
  readonly numbers: FloatingNumbers;
  readonly particles: ParticleField;
  readonly totalMs: number;

  private readonly scene: BattleScene;
  private readonly log: BattleLog;
  private readonly spec: AnimationSpec;
  private readonly plan: Schedule;
  private readonly steps: readonly TimedStep[];
  private readonly fx: readonly [FighterFx, FighterFx];
  private readonly numberText: (event: BattleEvent) => string | null;
  /** Переиспользуемая точка. Ни одного `new` за кадр. */
  private readonly point = new Vector3();

  private clock = 0;
  private cursor = 0;
  private shown = 0;
  private speedValue = 1;
  private pausedValue = false;
  private listener: (() => void) | null = null;

  constructor(options: PlayerOptions) {
    this.scene = options.scene;
    this.log = options.log;
    this.spec = options.spec ?? animations;
    this.numberText = options.numberText;

    this.plan = schedule(this.log, this.spec);
    this.steps = timeline(this.plan, this.spec);
    this.totalMs = this.plan.totalMs;

    const stage = this.spec.stage;
    // Направление выпада берётся из позиции, а не из индекса бойца:
    // «нулевой бьёт вправо» перестало бы быть верным в тот день, когда
    // кто-нибудь поменяет местами стороны в сцене.
    const [left, right] = this.scene.fighters;
    this.fx = [
      new FighterFx(left, stage, left.root.position.x <= right.root.position.x ? 1 : -1),
      new FighterFx(right, stage, right.root.position.x <= left.root.position.x ? 1 : -1),
    ];

    this.particles = new ParticleField();
    this.scene.scene.add(this.particles.mesh);

    this.numbers = new FloatingNumbers(this.scene.camera, new Vector3());
  }

  /**
   * Сколько событий лога уже показано.
   *
   * Состояние по этому числу сворачивает ЭКРАН, а не проигрыватель:
   * для свёртки нужен максимум HP, который присылает сервер, и знать
   * его проигрывателю незачем. Он показывает бой, а не считает его.
   */
  get shownCount(): number {
    return this.shown;
  }

  get clockMs(): number {
    return this.clock;
  }

  get paused(): boolean {
    return this.pausedValue;
  }

  get speed(): number {
    return this.speedValue;
  }

  get finished(): boolean {
    return this.clock >= this.totalMs;
  }

  /** Уведомление об изменении показанного: HUD и журнал перерисовываются. */
  onChange(listener: () => void): void {
    this.listener = listener;
  }

  setPaused(paused: boolean): void {
    this.pausedValue = paused;
    this.numbers.setPaused(paused);
  }

  /**
   * Скорость. Ноль — «мгновенно»: расписание не проигрывается, берётся
   * конечное состояние. Это не «очень быстро», а именно пропуск показа:
   * игрок, который уже видел бой, не должен ждать даже секунду.
   */
  setSpeed(speed: number): void {
    if (speed <= 0) {
      this.seek(this.totalMs);
      return;
    }
    this.speedValue = speed;
    this.numbers.setSpeed(speed);
  }

  /**
   * Перемотать к моменту, когда событие с данным индексом ЗАКОНЧИЛОСЬ.
   *
   * Не к началу: показанным считается уже случившееся, и перемотка
   * в начало прятала строку журнала, по которой кликнули (см.
   * `endOfIndex`).
   */
  seekToEvent(index: number): void {
    this.seek(endOfIndex(this.plan, index));
  }

  seek(timeMs: number): void {
    this.clock = Math.max(0, Math.min(timeMs, this.totalMs));
    this.cursor = stepCursorAt(this.steps, this.clock);
    // Перемотка гасит всё ПРЕХОДЯЩЕЕ: искры и числа от событий, которых
    // в новом моменте ещё (или уже) нет, — это ложь на экране.
    this.particles.clear();
    this.numbers.clear();
    this.fx[0].reset();
    this.fx[1].reset();

    /* А вот СТОЙКОЕ надо восстановить. Упавший боец — это не эффект,
       который доиграл, это положение, в котором он находится: после
       перемотки в конец он обязан лежать, даже если анимацию падения
       никто не смотрел. Обратное было видно на экране — «Сразу итог»
       оставлял труп стоять.

       Восстанавливается ПОВТОРНЫМ ПРОИГРЫВАНИЕМ стойких шагов
       с их настоящими моментами: тогда перемотка в середину падения
       даёт середину падения, а не позу «уже лежит». */
    for (const timed of persistentStepsBefore(this.steps, this.clock)) this.play(timed);

    this.refresh();
  }

  resize(width: number, height: number): void {
    this.numbers.resize(width, height);
  }

  /**
   * Кадр. `dt` в секундах реального времени.
   *
   * Ни `new`, ни литералов, ни `for...of`: правило M2a действует и здесь,
   * иначе замер аллокаций проверял бы только статичную сцену.
   */
  advance(dt: number): void {
    const scaled = this.pausedValue ? 0 : dt * this.speedValue;

    if (scaled > 0 && this.clock < this.totalMs) {
      this.clock = Math.min(this.totalMs, this.clock + scaled * 1000);
      while (this.cursor < this.steps.length) {
        const timed = this.steps[this.cursor];
        if (timed === undefined || timed.atMs > this.clock) break;
        this.play(timed);
        this.cursor++;
      }
      this.refresh();
    }

    this.particles.update(scaled);
    this.numbers.collect(this.clock);
    this.fx[0].update(this.clock);
    this.fx[1].update(this.clock);
  }

  private refresh(): void {
    const next = shownCount(this.plan, this.clock);
    if (next === this.shown) return;
    this.shown = next;
    this.listener?.();
  }

  private play(timed: TimedStep): void {
    const step = timed.step;
    const [actor, target] = actorsOf(timed.event);
    const who = step.on === 'actor' ? actor : target;
    const fx = this.fx[who];
    if (fx === undefined) return;

    switch (step.primitive) {
      case 'lunge':
        fx.startLunge(timed.atMs, step.durationMs, step.amount ?? 0);
        return;
      case 'shake':
        fx.startShake(timed.atMs, step.durationMs, step.amount ?? 0);
        return;
      case 'topple':
        fx.startTopple(timed.atMs, step.durationMs, step.amount ?? 0);
        return;
      case 'flash':
        fx.startFlash(timed.atMs, step.durationMs, step.amount ?? 1, step.color ?? 'bone');
        return;
      case 'burst':
        this.particles.burst(
          fx.burstPoint(this.point),
          step.color ?? 'bone',
          step.count ?? 1,
          step.durationMs,
        );
        return;
      case 'number': {
        const text = this.numberText(timed.event);
        // Нет текста — нет числа. Событие без величины (например,
        // «уклонение» без настройки строки) не должно рисовать пустой
        // прямоугольник над головой.
        if (text === null || text === '') return;
        this.numbers.spawn(
          fx.numberPoint(this.point),
          text,
          step.color ?? 'bone',
          step.durationMs,
          this.clock,
        );
        return;
      }
      default:
        return;
    }
  }

  dispose(): void {
    this.scene.scene.remove(this.particles.mesh);
    this.particles.dispose();
    this.numbers.dispose();
  }
}

/**
 * Кто действует и по кому. Событие несёт либо `actor`, либо `target`,
 * и второй участник — всегда противоположный: бойцов двое.
 *
 * Отдельная функция, а не поле в данных: связь «actor у dodge — это тот,
 * КТО уклонился» задана контрактом лога, и повторять её в animations.json
 * значило бы завести второй источник правды.
 */
export function actorsOf(event: BattleEvent): readonly [ActorIndex, ActorIndex] {
  const own: ActorIndex = 'actor' in event ? event.actor : other(event.target);
  return [own, other(own)];
}

function other(index: ActorIndex): ActorIndex {
  return index === 0 ? 1 : 0;
}
