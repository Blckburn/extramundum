import { Color, MeshBasicMaterial, MeshLambertMaterial, type Material } from 'three';

/**
 * Кэш материалов по цвету. GDD §3.4 и §13, пункт 19.
 *
 * В v1.0 на каждом меше вызывался `material.clone()`, и два бойца давали
 * СОТНИ материалов. Каждый материал — своя компиляция шейдера и своя
 * смена состояния GPU; это и есть главная причина, по которой тот рендер
 * не держал кадр на телефоне.
 *
 * Здесь материал существует ровно один на цвет. Число материалов в сцене
 * равно числу различных цветов в данных, и это проверяется тестом,
 * а не соблюдается на честном слове.
 *
 * **Следствие, о которое легко споткнуться:** материал общий, поэтому
 * его НЕЛЬЗЯ менять ради одного объекта. Мигание одной жаровни изменило
 * бы все объекты того же цвета разом. Всё, что мигает и вспыхивает,
 * делает это светом или собственным узлом, а не общим материалом.
 */
/**
 * Вид материала.
 *
 * `world` — обычный Lambert: его лепит свет сцены и съедает туман.
 * `city` — то, что пришло из Мунды. ART-BIBLE §3: «всё, что пришло
 * из города, СВЕТИТСЯ ИНАЧЕ, чем всё остальное», §5: силуэт города —
 * «единственное место в игре, нарисованное чисто». Здесь это не
 * метафора и не подобранный оттенок, а другой материал: без освещения
 * и без тумана, то есть ровная заливка, которую не трогает ничто
 * из происходящего снаружи стены.
 *
 * Такой материал ещё и дешевле: `MeshBasicMaterial` не считает свет.
 */
export type MaterialKind = 'world' | 'city';

export class MaterialCache {
  /** Ключ — «вид:цвет». Один материал на пару, а не на меш. */
  private readonly byColor = new Map<string, Material>();

  /** Сколько материалов заведено. Ровно эту величину и меряет бюджет. */
  get size(): number {
    return this.byColor.size;
  }

  /** Заведённые цвета — для отчёта и для теста про зарезервированные. */
  get colors(): readonly string[] {
    return [...this.byColor.keys()];
  }

  get(hex: string, kind: MaterialKind = 'world'): Material {
    const key = `${kind}:${hex}`;
    const existing = this.byColor.get(key);
    if (existing !== undefined) return existing;

    // `.convertSRGBToLinear()` не нужен: three сам считает входной цвет
    // в sRGB, а ART-BIBLE §6 фиксирует именно sRGB.
    const color = new Color(hex);
    const material =
      kind === 'city'
        ? new MeshBasicMaterial({ color, fog: false })
        : new MeshLambertMaterial({ color });

    this.byColor.set(key, material);
    return material;
  }

  dispose(): void {
    for (const material of this.byColor.values()) material.dispose();
    this.byColor.clear();
  }
}
