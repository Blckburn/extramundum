import type { FlickerSource } from './rig.js';

/**
 * Кадровый цикл. GDD §3.4 и §13, пункт 20.
 *
 * **Ни одного обхода сцены в кадре.** В v1.0 `scene.traverse()`
 * выполнялся каждый кадр на каждого бойца ради вспышки урона, плюс
 * ещё один полный обход ради мерцания факелов. Обход сцены — это
 * посещение каждого объекта ради нескольких, которым что-то нужно;
 * с ростом сцены цена растёт, а польза нет.
 *
 * Здесь вместо обхода ЯВНЫЕ СПИСКИ. Объект, которому нужно обновление,
 * регистрируется один раз при сборке. Цикл проходит по спискам, а не
 * по сцене, и его стоимость равна числу движущихся объектов.
 *
 * **Ноль аллокаций за кадр.** Ни одного `new`, ни одного литерала
 * массива или объекта, ни одного замыкания в `update`. Это проверяется
 * тестом, который считает выделения: аллокация в кадре означает работу
 * сборщику мусора, а сборка мусора означает дёрганый кадр ровно тогда,
 * когда на экране что-то происходит.
 */
export class FrameLoop {
  /** Мерцающие источники света. Пусто — значит мерцать нечему. */
  private readonly flickerables: FlickerSource[] = [];

  /** Секунд с начала. Поле, а не локальная переменная: не аллоцируется. */
  private elapsed = 0;

  get flickerCount(): number {
    return this.flickerables.length;
  }

  registerFlicker(sources: readonly FlickerSource[]): void {
    for (const source of sources) this.flickerables.push(source);
  }

  /**
   * Один кадр. `dt` в секундах.
   *
   * Обратите внимание на форму цикла: индексный `for` по массиву,
   * без `for...of` и без методов-итераторов. `for...of` по массиву
   * создаёт итератор на каждый вызов — то есть аллокацию в кадре.
   */
  update(dt: number): void {
    this.elapsed += dt;

    for (let i = 0; i < this.flickerables.length; i++) {
      const source = this.flickerables[i];
      if (source === undefined) continue;
      // Две несоизмеримые синусоиды дают неровное пламя без random()
      // и без хранения состояния: тот же сид — тот же кадр.
      const wobble =
        Math.sin(this.elapsed * 11.3 + source.phase) * 0.6 +
        Math.sin(this.elapsed * 4.7 + source.phase * 1.7) * 0.4;
      source.light.intensity = source.base * (1 + wobble * source.amount);
    }
  }
}
