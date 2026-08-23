/**
 * Пул объектов. GDD §3.4 и §13, пункт 21.
 *
 * «Цифры урона — новые DOM-элементы без пула». Каждая цифра в v1.0
 * создавала узел и геометрию, и на кадре с пятью попаданиями сборщик
 * мусора получал работу ровно тогда, когда её меньше всего можно себе
 * позволить — во время самого зрелищного момента боя.
 *
 * Пул заводится ОДИН раз при старте и дальше не растёт. Переполнение
 * не расширяет пул, а переиспользует самый старый занятый элемент:
 * лучше потерять одну цифру из тридцати, чем аллоцировать в кадре.
 *
 * В M2a пула не было намеренно: потреблять его было нечем, а код без
 * потребителя мы не пишем. Потребитель появился здесь.
 */
export type Pooled<T> = {
  readonly value: T;
  /** Занят ли. Свободные не обновляются и не рисуются. */
  active: boolean;
  /** Порядок выдачи — по нему вытесняется самый старый при переполнении. */
  serial: number;
};

export class Pool<T> {
  private readonly slots: Pooled<T>[] = [];
  private next = 0;

  /**
   * @param size   ёмкость. Не растёт: рост в кадре — это аллокация.
   * @param create фабрика. Вызывается `size` раз при создании пула
   *               и НИ РАЗУ после — на это есть тест.
   */
  constructor(
    readonly size: number,
    create: (index: number) => T,
  ) {
    for (let i = 0; i < size; i++) {
      this.slots.push({ value: create(i), active: false, serial: 0 });
    }
  }

  get all(): readonly Pooled<T>[] {
    return this.slots;
  }

  get activeCount(): number {
    let count = 0;
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i]?.active === true) count++;
    }
    return count;
  }

  /**
   * Взять свободный элемент. Если свободных нет — забрать самый старый
   * занятый. Никогда не возвращает `null`: вызывающему коду не нужна
   * ветка «а вдруг не дали», и не нужна аллокация в кадре.
   */
  acquire(): Pooled<T> {
    let free: Pooled<T> | undefined;
    let oldest: Pooled<T> | undefined;

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot === undefined) continue;
      if (!slot.active) {
        free = slot;
        break;
      }
      if (oldest === undefined || slot.serial < oldest.serial) oldest = slot;
    }

    const slot = free ?? oldest;
    // Пул нулевого размера — ошибка сборки, а не случай рантайма.
    if (slot === undefined) throw new Error('пул пуст: размер должен быть больше нуля');

    slot.active = true;
    slot.serial = ++this.next;
    return slot;
  }

  release(slot: Pooled<T>): void {
    slot.active = false;
  }

  releaseAll(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot !== undefined) slot.active = false;
    }
  }
}
