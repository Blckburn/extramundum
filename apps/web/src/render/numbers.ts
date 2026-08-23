import { paletteColor } from '@extramundum/data';
import type { PerspectiveCamera, Vector3 } from 'three';

import { Pool } from './pool.js';

/**
 * Всплывающие числа над бойцами. GDD §3.2, §13 пункт 21.
 *
 * ПОЧЕМУ DOM, А НЕ СПРАЙТЫ. Главный довод не производительность,
 * а резкость текста и локализация: спрайтовый атлас цифр рисуется под
 * один размер и одну плотность пикселей, а на экранах, для которых
 * проектируется игра, плотность разная. Вдобавок атлас цифр спорит
 * с ART-BIBLE §7: «никакого текста внутри изображений» — а «уклонение»
 * это текст, и его ещё и переводить.
 *
 * ПОЧЕМУ ЭТО НЕ СТОИТ КАДРА. Наивная реализация проецирует координаты
 * каждого активного числа в каждом кадре и пишет строку в `style` —
 * то есть делает работу и мусорит ровно в тот момент, когда на экране
 * что-то происходит. Здесь не так:
 *
 *   - камера за бой не двигается, поэтому мировая точка проецируется
 *     ОДИН раз, при рождении числа, а не шестьдесят раз в секунду;
 *   - подъём и затухание — CSS-анимация на дочернем узле. Её крутит
 *     браузер на композиторе, JS в этом не участвует вовсе.
 *
 * Стоимость за кадр — ноль вызовов и ноль аллокаций. Замер аллокаций
 * из M2a обязан показывать ноль и во время боя, а не только на статичной
 * сцене, и цифры урона это правило не нарушают.
 *
 * Цена такого решения — число, родившееся до поворота экрана, доиграет
 * на старом месте: пересчитывать его позицию было бы возвратом к работе
 * в кадре ради случая, который длится 900 мс раз в никогда.
 */

/** Сколько чисел живёт одновременно. Пул не растёт (см. pool.ts). */
const CAPACITY = 24;

type Slot = {
  readonly root: HTMLElement;
  readonly float: HTMLElement;
  /** Когда истекает, по часам воспроизведения. Освобождает слот. */
  expiresAtMs: number;
};

export class FloatingNumbers {
  readonly element: HTMLElement;
  private readonly pool: Pool<Slot>;
  private readonly camera: PerspectiveCamera;
  /** Переиспользуемый вектор: проекция не должна аллоцировать. */
  private readonly projected: Vector3;
  private width = 1;
  private height = 1;
  private speed = 1;

  /**
   * @param camera    камера сцены: проекция считается по ней.
   * @param scratch   вектор под проекцию. Приходит снаружи, потому что
   *                  three грузится динамическим импортом и `new Vector3`
   *                  здесь потребовал бы статического импорта класса.
   */
  constructor(camera: PerspectiveCamera, scratch: Vector3) {
    this.camera = camera;
    this.projected = scratch;

    this.element = document.createElement('div');
    this.element.className = 'numbers';
    this.element.setAttribute('aria-hidden', 'true');

    this.pool = new Pool<Slot>(CAPACITY, () => {
      const root = document.createElement('div');
      root.className = 'numbers__item';
      const float = document.createElement('span');
      float.className = 'numbers__float';
      root.append(float);
      this.element.append(root);
      return { root, float, expiresAtMs: 0 };
    });
  }

  get activeCount(): number {
    return this.pool.activeCount;
  }

  /** Размер области, в которой числа позиционируются. Пиксели CSS. */
  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  /**
   * Скорость воспроизведения. Влияет только на РОЖДАЮЩИЕСЯ числа
   * и на уже живые — их немного, и это событие интерфейса, а не кадр.
   */
  setSpeed(speed: number): void {
    this.speed = speed <= 0 ? 1 : speed;
    const slots = this.pool.all;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot === undefined || !slot.active) continue;
      slot.value.float.style.animationDuration = this.durationCss(
        slot.value.float.dataset['durationMs'],
      );
    }
  }

  setPaused(paused: boolean): void {
    this.element.classList.toggle('numbers--paused', paused);
  }

  private durationCss(raw: string | undefined): string {
    const base = raw === undefined ? 900 : Number(raw);
    return `${Math.round(base / this.speed)}ms`;
  }

  /**
   * Показать число (или слово) над мировой точкой.
   *
   * `nowMs` — часы воспроизведения, а не системное время: при перемотке
   * назад часы уходят назад, и просроченные слоты обязаны освободиться.
   */
  spawn(world: Vector3, text: string, colorKey: string, durationMs: number, nowMs: number): void {
    this.projected.copy(world).project(this.camera);
    const x = (this.projected.x * 0.5 + 0.5) * this.width;
    const y = (-this.projected.y * 0.5 + 0.5) * this.height;

    const slot = this.pool.acquire();
    const { root, float } = slot.value;
    slot.value.expiresAtMs = nowMs + durationMs / this.speed;

    root.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    root.style.display = 'block';

    float.textContent = text;
    float.style.color = paletteColor(colorKey);
    float.dataset['durationMs'] = String(durationMs);
    // Перезапуск анимации на переиспользованном узле: без снятия класса
    // браузер считает анимацию той же самой и не играет её заново.
    float.classList.remove('numbers__float--play');
    void float.offsetWidth;
    float.style.animationDuration = this.durationCss(String(durationMs));
    float.classList.add('numbers__float--play');
  }

  /**
   * Убрать отжившие. Вызывается из цикла воспроизведения, а не из кадра
   * рендера: работа здесь пропорциональна ёмкости пула, и делать её
   * шестьдесят раз в секунду незачем.
   *
   * Перемотку назад этот метод не обрабатывает и не должен: там часы
   * уходят назад целиком, и проигрыватель зовёт `clear()`.
   */
  collect(nowMs: number): void {
    const slots = this.pool.all;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot === undefined || !slot.active) continue;
      if (nowMs >= slot.value.expiresAtMs) {
        this.hide(slot.value);
        this.pool.release(slot);
      }
    }
  }

  /** Перемотка не должна оставлять на экране числа из будущего. */
  clear(): void {
    const slots = this.pool.all;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot === undefined) continue;
      this.hide(slot.value);
    }
    this.pool.releaseAll();
  }

  private hide(slot: Slot): void {
    slot.root.style.display = 'none';
    slot.float.classList.remove('numbers__float--play');
  }

  dispose(): void {
    this.element.remove();
  }
}
