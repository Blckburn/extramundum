import { paletteColor } from '@extramundum/data';
import { WebGLRenderer } from 'three';

import { measureScene, type SceneBudget } from './budget.js';
import { createBattleScene, frameCamera, type BattleScene } from './scene.js';

export { measureScene, budgetViolations, DRAW_CALLS_UPPER_BOUND_HOLDS } from './budget.js';
export type { SceneBudget } from './budget.js';
export { createBattleScene, frameCamera } from './scene.js';
export type { BattleScene } from './scene.js';
export { MaterialCache } from './materials.js';
export { buildRig, GeometryCache } from './rig.js';
export type { BuiltRig } from './rig.js';
export { FrameLoop } from './frame.js';

export type RenderHandle = {
  readonly scene: BattleScene;
  readonly budget: SceneBudget;
  /** Живые вызовы отрисовки за последний кадр — от самого рендера. */
  drawCalls(): number;
  stop(): void;
};

/**
 * Запуск рендера в существующий canvas.
 *
 * Один `WebGLRenderer` на страницу. Мгновенный `dispose` при остановке:
 * контекстов WebGL у браузера конечное число, и утечка одного из них
 * при переходе между экранами через несколько переходов роняет вкладку.
 */
export function mountBattleScene(canvas: HTMLCanvasElement): RenderHandle {
  const built = createBattleScene(canvas.clientWidth / Math.max(1, canvas.clientHeight));

  const renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
  });
  // Пиксельное отношение режется до двух: на телефоне с ratio 3 сцена
  // рисуется в девять раз больше пикселей, чем нужно, и кадр рушится
  // при том же числе вызовов отрисовки.
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
  renderer.setClearColor(paletteColor('ink'), 1);

  let running = true;
  let last = 0;

  const resize = (): void => {
    const width = canvas.clientWidth;
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    frameCamera(built.camera, width / height);
  };
  resize();
  globalThis.addEventListener('resize', resize);

  const tick = (now: number): void => {
    if (!running) return;
    const dt = last === 0 ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;
    built.loop.update(dt);
    renderer.render(built.scene, built.camera);
    globalThis.requestAnimationFrame(tick);
  };
  globalThis.requestAnimationFrame(tick);

  return {
    scene: built,
    budget: measureScene(built.scene),
    drawCalls: () => renderer.info.render.calls,
    stop() {
      running = false;
      globalThis.removeEventListener('resize', resize);
      renderer.dispose();
      built.dispose();
    },
  };
}
