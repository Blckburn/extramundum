import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
} from 'three';

import { paletteHex } from './palette.js';
import { Pool, type Pooled } from './pool.js';

/**
 * Партиклы. GDD §3.4: пул объектов, и бюджет draw calls конечен.
 *
 * ОДИН `InstancedMesh` на всю сцену — то есть ОДИН вызов отрисовки
 * независимо от числа частиц. Без инстансинга полсотни искр от удара
 * стоили бы полсотни вызовов, и бюджет §3.4 закончился бы на первом же
 * крите.
 *
 * Следствие, важное для замера: с появлением этого класса число мешей
 * перестаёт быть осмысленной оценкой нагрузки. Меш здесь один, а частиц
 * в нём сотня. Верхняя граница вызовов не ломается (инстанс рисуется
 * одним вызовом), но перестаёт что-либо говорить о том, сколько работы
 * делает GPU. Поэтому `measureScene` теперь считает инстансы отдельно —
 * см. budget.ts.
 *
 * Цвет — в атрибуте экземпляра, а не в материале: материал один на все
 * частицы, и красить его под конкретный всплеск значило бы перекрасить
 * все остальные разом. Та же причина, по которой мерцает свет,
 * а не материал (M2a).
 */

type Particle = {
  readonly position: Vector3;
  readonly velocity: Vector3;
  readonly color: Color;
  /** Прожито секунд. Отдельное поле, чтобы не аллоцировать в кадре. */
  age: number;
  lifetime: number;
  size: number;
};

/** Сколько частиц живёт одновременно. Пул не растёт (см. pool.ts). */
const CAPACITY = 220;

export class ParticleField {
  readonly mesh: InstancedMesh;
  private readonly pool: Pool<Particle>;
  /** Переиспользуемый объект для матриц. Ни одного `new` в кадре. */
  private readonly scratch = new Object3D();
  private readonly gravity = -6.5;

  constructor() {
    const geometry = new BoxGeometry(1, 1, 1);
    // Без освещения: искра — источник, а не поверхность. Заодно дешевле.
    const material = new MeshBasicMaterial({ transparent: true, opacity: 0.95 });
    this.mesh = new InstancedMesh(geometry, material, CAPACITY);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.name = 'particles';
    this.mesh.frustumCulled = false;
    this.mesh.count = CAPACITY;

    this.pool = new Pool<Particle>(CAPACITY, () => ({
      position: new Vector3(),
      velocity: new Vector3(),
      color: new Color(),
      age: 0,
      lifetime: 1,
      size: 0.06,
    }));

    // Свободные частицы прячутся масштабом в ноль: `count` менять нельзя,
    // не сломав соответствие индексов, а нулевой масштаб не рисуется.
    for (let i = 0; i < CAPACITY; i++) this.hide(i);
  }

  get activeCount(): number {
    return this.pool.activeCount;
  }

  private hide(index: number): void {
    this.scratch.position.set(0, -1000, 0);
    this.scratch.scale.set(0, 0, 0);
    this.scratch.updateMatrix();
    this.mesh.setMatrixAt(index, this.scratch.matrix);
  }

  /**
   * Всплеск. Направления берутся из индекса, а не из random(): один лог
   * обязан давать одну картинку, иначе воспроизведение не детерминировано
   * и два просмотра одного боя выглядят по-разному.
   */
  burst(at: Vector3, colorKey: string, count: number, lifetimeMs: number): void {
    // Число, а не строка: `Color.set('#rrggbb')` разбирает строку
    // регулярным выражением и аллоцирует — в бою это заметно (palette.ts).
    const hex = paletteHex(colorKey);
    for (let i = 0; i < count; i++) {
      const slot = this.pool.acquire();
      const p = slot.value;
      // Золотое сечение по углу даёт равномерный веер без случайности.
      const angle = i * 2.399963;
      const speed = 1.4 + ((i * 7) % 11) * 0.16;
      p.position.copy(at);
      p.velocity.set(
        Math.cos(angle) * speed * 0.6,
        1.1 + ((i * 5) % 7) * 0.22,
        Math.sin(angle) * speed * 0.6,
      );
      p.color.setHex(hex);
      p.age = 0;
      p.lifetime = lifetimeMs / 1000;
      p.size = 0.05 + ((i * 3) % 5) * 0.012;
    }
  }

  /** Сбросить всё: перемотка боя не должна оставлять искры от будущего. */
  clear(): void {
    this.pool.releaseAll();
    for (let i = 0; i < CAPACITY; i++) this.hide(i);
  }

  /**
   * Шаг кадра. Ни одного `new`, ни одного литерала, ни одного `for...of`:
   * замер аллокаций из M2a должен продолжать показывать ноль во время боя,
   * а не только на статичной сцене.
   */
  update(dt: number): void {
    const slots = this.pool.all;
    let needsColor = false;

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i] as Pooled<Particle> | undefined;
      if (slot === undefined || !slot.active) continue;

      const p = slot.value;
      p.age += dt;
      if (p.age >= p.lifetime) {
        this.pool.release(slot);
        this.hide(i);
        continue;
      }

      p.velocity.y += this.gravity * dt;
      p.position.x += p.velocity.x * dt;
      p.position.y += p.velocity.y * dt;
      p.position.z += p.velocity.z * dt;

      const fade = 1 - p.age / p.lifetime;
      this.scratch.position.copy(p.position);
      const scale = p.size * fade;
      this.scratch.scale.set(scale, scale, scale);
      this.scratch.updateMatrix();
      this.mesh.setMatrixAt(i, this.scratch.matrix);
      this.mesh.setColorAt(i, p.color);
      needsColor = true;
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    if (needsColor && this.mesh.instanceColor !== null) {
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as { dispose(): void }).dispose();
    this.mesh.dispose();
  }
}
