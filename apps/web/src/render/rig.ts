import { paletteColor } from '@extramundum/data';
import type { RigShape, RigSlot, RigSpec } from '@extramundum/shared';
import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Matrix3,
  Mesh,
  Object3D,
  PointLight,
  Vector3,
  type Material,
} from 'three';

import type { MaterialCache } from './materials.js';

/**
 * Сборка тела из декларативной спецификации. GDD §3.4.
 *
 * «Тело собирается по JSON-описанию, а не хардкодом в `buildRig`. Новый
 * монстр или шлем = запись в данных, не правка кода.» Здесь нет ни одного
 * имени узла, ни одного размера и ни одного цвета: всё приходит из
 * `packages/data/rigs/*.json`.
 *
 * Проверяется это тестом, который меняет ЧИСЛО в тестовой спецификации
 * и убеждается, что геометрия изменилась. Утверждение «код не содержит
 * констант» иначе пришлось бы принимать на веру.
 */

export type FlickerSource = {
  readonly light: PointLight;
  /** Базовая интенсивность, от которой считается мерцание. */
  readonly base: number;
  /** Амплитуда, доля базовой интенсивности. */
  readonly amount: number;
  /** Сдвиг фазы, чтобы два факела не мерцали в такт. */
  readonly phase: number;
};

export type BuiltRig = {
  readonly root: Group;
  /** Узлы по имени — для адресного обращения без обхода сцены. */
  readonly nodes: ReadonlyMap<string, Object3D>;
  /** Меши экипировки по слоту. Слот может дать несколько мешей: наручи парные. */
  readonly slots: ReadonlyMap<RigSlot, readonly Mesh[]>;
  /** Источники света, которым нужно мерцание. Явный список вместо обхода. */
  readonly flickerables: readonly FlickerSource[];
  /** Узлы городского происхождения — им разрешены зарезервированные цвета. */
  readonly cityNodes: ReadonlySet<Object3D>;
};

/**
 * Кэш геометрий по размеру коробки.
 *
 * Та же мысль, что у материалов: две коробки одного размера — одна
 * геометрия. Без кэша сборка двух бойцов давала бы полсотни одинаковых
 * буферов, и каждый занимал бы свою память на GPU.
 */
export class GeometryCache {
  /** Ключ — «форма:ширина:высота:глубина». Одна геометрия на габарит. */
  private readonly bySize = new Map<string, BufferGeometry>();

  get size(): number {
    return this.bySize.size;
  }

  get(w: number, h: number, d: number, shape: RigShape = 'box'): BufferGeometry {
    const key = `${shape}:${w}:${h}:${d}`;
    const existing = this.bySize.get(key);
    if (existing !== undefined) return existing;

    const geometry =
      shape === 'box'
        ? new BoxGeometry(w, h, d)
        : shape === 'pyramid'
          ? pyramid(w, h, d)
          : gable(w, h, d);
    this.bySize.set(key, geometry);
    return geometry;
  }

  dispose(): void {
    for (const geometry of this.bySize.values()) geometry.dispose();
    this.bySize.clear();
  }
}

/**
 * Четырёхскатная пирамида с прямоугольным основанием.
 *
 * Собирается вручную, а не из `ConeGeometry`: у конуса основание —
 * вписанный многоугольник, то есть при четырёх сегментах квадрат,
 * повёрнутый на 45°, и задать разные ширину и глубину нечем. Башне
 * города нужен ровно прямоугольник основания.
 */
function pyramid(w: number, h: number, d: number): BufferGeometry {
  const [x, y, z] = [w / 2, h / 2, d / 2];
  const apex = [0, y, 0];
  const base = [
    [-x, -y, z],
    [x, -y, z],
    [x, -y, -z],
    [-x, -y, -z],
  ];
  const tris: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = base[i] as number[];
    const b = base[(i + 1) % 4] as number[];
    tris.push(...a, ...b, ...apex);
  }
  // Дно: две треугольные грани. Снизу его не видно, но без них
  // силуэт сбоку проваливается.
  tris.push(...(base[0] as number[]), ...(base[2] as number[]), ...(base[1] as number[]));
  tris.push(...(base[0] as number[]), ...(base[3] as number[]), ...(base[2] as number[]));
  return fromTriangles(tris);
}

/** Двускатная крыша: треугольная призма, конёк вдоль оси Z. */
function gable(w: number, h: number, d: number): BufferGeometry {
  const [x, y, z] = [w / 2, h / 2, d / 2];
  const tris: number[] = [];
  const push = (...points: number[][]) => {
    for (const p of points) tris.push(...p);
  };
  // Два ската.
  push([-x, -y, z], [0, y, z], [0, y, -z]);
  push([-x, -y, z], [0, y, -z], [-x, -y, -z]);
  push([x, -y, -z], [0, y, -z], [0, y, z]);
  push([x, -y, -z], [0, y, z], [x, -y, z]);
  // Два фронтона.
  push([-x, -y, z], [x, -y, z], [0, y, z]);
  push([x, -y, -z], [-x, -y, -z], [0, y, -z]);
  // Дно.
  push([-x, -y, -z], [x, -y, -z], [x, -y, z]);
  push([-x, -y, -z], [x, -y, z], [-x, -y, z]);
  return fromTriangles(tris);
}

function fromTriangles(positions: number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  // Нормали нужны Lambert; у городских материалов света нет, но одна
  // и та же геометрия может достаться и обычному узлу.
  geometry.computeVertexNormals();
  return geometry;
}

export function buildRig(
  spec: RigSpec,
  materials: MaterialCache,
  geometries: GeometryCache,
): BuiltRig {
  const nodes = new Map<string, Object3D>();
  const slots = new Map<RigSlot, Mesh[]>();
  const flickerables: FlickerSource[] = [];
  const cityNodes = new Set<Object3D>();
  const root = new Group();
  root.name = spec.id;

  for (const node of spec.nodes) {
    const [w, h, d] = node.size;
    const isMesh = w > 0 && h > 0 && d > 0;

    // Узел нулевого размера — точка привязки, а не невидимая коробка.
    // Невидимый меш всё равно стоил бы обхода и места в сцене.
    // Вид материала — из данных: узел городского происхождения получает
    // чистую заливку без света и тумана (ART-BIBLE §3 и §5).
    const object: Object3D = isMesh
      ? new Mesh(
          geometries.get(w, h, d, node.shape),
          materials.get(paletteColor(node.color), node.origin === 'city' ? 'city' : 'world'),
        )
      : new Object3D();

    object.name = node.name;
    object.position.set(...node.offset);

    const parent = node.parent === null ? root : nodes.get(node.parent);
    if (parent === undefined) {
      // Порядок узлов в файле — часть контракта: родитель обязан быть
      // объявлен раньше ребёнка. Ошибка данных, а не повод молча
      // подвесить узел к корню и получить руку, растущую из земли.
      throw new Error(
        `риг «${spec.id}»: узел «${node.name}» ссылается на неизвестного родителя «${node.parent}»`,
      );
    }
    parent.add(object);
    nodes.set(node.name, object);

    if (node.origin === 'city') cityNodes.add(object);

    if (node.slot !== undefined && object instanceof Mesh) {
      const list = slots.get(node.slot) ?? [];
      list.push(object);
      slots.set(node.slot, list);
    }

    if (node.light !== undefined) {
      const light = new PointLight(
        paletteColor(node.light.color),
        node.light.intensity,
        node.light.distance,
      );
      object.add(light);
      flickerables.push({
        light,
        base: node.light.intensity,
        amount: node.light.flicker,
        // Фаза выводится из имени узла, а не из random(): сцена обязана
        // выглядеть одинаково при каждом запуске, как и бой при том же сиде.
        phase: hashPhase(node.name),
      });
    }
  }

  if (spec.static === true) mergeByMaterial(root, spec, nodes, slots, flickerables, cityNodes);

  return { root, nodes, slots, flickerables, cityNodes };
}

/**
 * Слить меши неподвижного рига в один на материал.
 *
 * Зачем: силуэт города — двадцать два вызова отрисовки на объект,
 * который за весь бой не сдвинется ни разу. Бюджет §3.4 конечен,
 * и первое, что в него упрётся в M2b, — партиклы; отдавать запас
 * неподвижной декорации расточительно.
 *
 * ПОЧЕМУ НЕ В ОДИН МЕШ, А ПО МАТЕРИАЛУ. Один меш потребовал бы либо
 * массива материалов на нём, либо цвета в вершинах. Первое ломает
 * верхнюю границу вызовов отрисовки в ОПАСНУЮ сторону: меш с массивом
 * рисуется по группам, то есть один объект даёт несколько вызовов,
 * и весь замер `budget.ts` перестаёт значить. Второе увело бы цвет
 * из палитры в буфер вершин, и проверка «зарезервированный цвет только
 * у города» осталась бы без того, что проверять. Разница в выигрыше
 * при этом невелика: тонов у города пять.
 *
 * Иерархия после слияния не сохраняется — поэтому `static` запрещён
 * ригам со слотами и со светом, и это проверяется здесь, а не
 * в комментарии.
 */
function mergeByMaterial(
  root: Group,
  spec: RigSpec,
  nodes: Map<string, Object3D>,
  slots: Map<RigSlot, Mesh[]>,
  flickerables: FlickerSource[],
  cityNodes: Set<Object3D>,
): void {
  if (slots.size > 0) {
    throw new Error(`риг «${spec.id}»: static запрещён — слияние стёрло бы слоты экипировки`);
  }
  if (flickerables.length > 0) {
    throw new Error(`риг «${spec.id}»: static запрещён — слияние стёрло бы узлы со светом`);
  }

  root.updateMatrixWorld(true);

  const byMaterial = new Map<Material, Mesh[]>();
  const collect = (object: Object3D): void => {
    if (object instanceof Mesh) {
      const list = byMaterial.get(object.material as Material) ?? [];
      list.push(object);
      byMaterial.set(object.material as Material, list);
    }
    for (const child of object.children) collect(child);
  };
  collect(root);

  root.clear();
  nodes.clear();
  const wasCity = new Set(cityNodes);
  cityNodes.clear();

  for (const [material, meshes] of byMaterial) {
    const merged = new Mesh(mergeGeometries(meshes), material);
    merged.name = `${spec.id}:merged`;
    // Слитый меш принадлежит городу, если из города были все его части.
    // Смешанного случая быть не может: материал у города свой.
    if (meshes.every((mesh) => wasCity.has(mesh))) cityNodes.add(merged);
    root.add(merged);
    nodes.set(merged.name + ':' + String(nodes.size), merged);
  }
}

/**
 * Собрать одну геометрию из нескольких, применив мировые матрицы.
 *
 * Исходные геометрии приходят из кэша и разделяются с другими ригами,
 * поэтому их нельзя трогать: вершины переносятся в новый буфер, а не
 * преобразуются на месте.
 */
function mergeGeometries(meshes: readonly Mesh[]): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const point = new Vector3();
  const normalMatrix = new Matrix3();

  for (const mesh of meshes) {
    // `toNonIndexed` выравнивает коробки (индексированные) и формы,
    // собранные вручную (без индекса), к одному виду.
    const geometry = mesh.geometry.index === null ? mesh.geometry : mesh.geometry.toNonIndexed();
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    normalMatrix.getNormalMatrix(mesh.matrixWorld);

    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      positions.push(point.x, point.y, point.z);
      point.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
      normals.push(point.x, point.y, point.z);
    }

    if (geometry !== mesh.geometry) geometry.dispose();
  }

  const merged = new BufferGeometry();
  merged.setAttribute('position', new Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  return merged;
}

/** Детерминированная фаза из имени: ноль обращений к random(). */
function hashPhase(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return ((hash % 1000) / 1000) * Math.PI * 2;
}
