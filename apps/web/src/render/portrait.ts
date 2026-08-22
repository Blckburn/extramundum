import { paletteColor, RIGS } from '@extramundum/data';
import type { RigSlot } from '@extramundum/shared';
import { AmbientLight, DirectionalLight, PerspectiveCamera, Scene, WebGLRenderer } from 'three';

import { MaterialCache } from './materials.js';
import { buildRig, GeometryCache } from './rig.js';

/**
 * Портрет бойца в экране снаряжения. GDD §5.3: «восемь слотов, и ВСЕ
 * ВИДНЫ НА РИГЕ — визуальный прогресс бесплатно».
 *
 * Показывает ровно одно: что надето. Пустой слот скрывает свой узел,
 * занятый — показывает. Без этого обещание §5.3 остаётся словами:
 * узлы на риге есть с M2a, но игрок не видит разницы между голым
 * персонажем и одетым.
 *
 * Цветом редкость НЕ показывается, и это не забывчивость. Палитра
 * ART-BIBLE §3 состоит из семи ролей, и цвета редкости в них нет;
 * завести его — правка арт-библии, то есть решение человека. Редкость
 * видно в сетке предметов, где для неё есть рамка.
 *
 * Сцена своя, а не боевая: арена, город и второй боец здесь не нужны,
 * а стоят вызовов отрисовки и памяти.
 */

export type PortraitHandle = {
  /** Показать ровно эти слоты. Остальные узлы скрываются. */
  show(worn: ReadonlySet<RigSlot>): void;
  stop(): void;
};

export function mountPortrait(canvas: HTMLCanvasElement): PortraitHandle {
  const materials = new MaterialCache();
  const geometries = new GeometryCache();
  const scene = new Scene();

  // Свет тот же по смыслу, что в бою: слабый общий плюс заполняющий
  // со стороны камеры, иначе боец читается чёрным пятном (ART-BIBLE §2).
  scene.add(new AmbientLight(paletteColor('parchment'), 0.42));
  const fill = new DirectionalLight(paletteColor('bone'), 0.75);
  fill.position.set(2, 5, 8);
  scene.add(fill);

  const rig = buildRig(RIGS.humanoid, materials, geometries);
  rig.root.rotation.y = 0.35;
  scene.add(rig.root);

  const camera = new PerspectiveCamera(32, 1, 0.1, 40);
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));

  const resize = (): void => {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Рост бойца около 1.9 м, ступни на нуле: камера смотрит в пояс,
    // иначе фигура упирается в верхний край или тонет в нижнем.
    camera.position.set(0, 1.05, 5.2);
    camera.lookAt(0, 0.95, 0);
    camera.updateProjectionMatrix();
  };
  resize();
  globalThis.addEventListener('resize', resize);

  let running = true;
  const tick = (): void => {
    if (!running) return;
    renderer.render(scene, camera);
    globalThis.requestAnimationFrame(tick);
  };
  globalThis.requestAnimationFrame(tick);

  return {
    show(worn) {
      for (const [slot, meshes] of rig.slots) {
        for (const mesh of meshes) mesh.visible = worn.has(slot);
      }
    },
    stop() {
      running = false;
      globalThis.removeEventListener('resize', resize);
      renderer.dispose();
      geometries.dispose();
      materials.dispose();
    },
  };
}
