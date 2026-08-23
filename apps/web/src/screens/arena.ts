import { clear, el } from '../dom.ts';
import { t } from '../i18n.ts';

/**
 * Экран арены — статичная сцена M2a.
 *
 * Воспроизведения `BattleLog` здесь нет и не должно быть: это M2b.
 * Задача этапа — фундамент, на который воспроизведение потом ляжет,
 * и возможность увидеть цифры бюджетов на живом устройстве.
 *
 * **three.js грузится динамическим импортом.** Бюджет GDD §3.4 требует
 * первый кадр поселения быстрее двух секунд на 4G, а движок рендера —
 * самая тяжёлая часть клиента. Игрок, который открыл деревню и не пошёл
 * в бой, не должен его качать вовсе.
 */
export function renderArena(root: HTMLElement, onBack: () => void): void {
  clear(root);

  const canvas = el('canvas', { class: 'arena__canvas' }) as HTMLCanvasElement;
  const readout = el('p', { class: 'arena__readout' }, [t('arena.loading')]);

  const back = el('button', { class: 'button button--ghost', type: 'button' }, [t('action.back')]);

  root.append(
    el('main', { class: 'screen screen--arena' }, [
      el('div', { class: 'arena__stage' }, [canvas]),
      el('div', { class: 'arena__bar' }, [readout, back]),
    ]),
  );

  let handle: { stop: () => void } | null = null;
  back.addEventListener('click', () => {
    handle?.stop();
    onBack();
  });

  void (async () => {
    const { mountBattleScene } = await import('../render/index.ts');
    // Экран мог смениться, пока грузился чанк: монтировать рендер
    // в отсоединённый canvas значит оставить висеть контекст WebGL.
    if (!canvas.isConnected) return;

    const mounted = mountBattleScene(canvas);
    handle = mounted;

    // Цифры бюджета прямо на экране: проверять их надо на телефоне,
    // а не в отчёте о том, как оно вело себя на десктопе.
    const budget = mounted.budget;
    readout.textContent = t('arena.budget', {
      draws: String(mounted.drawCalls() || budget.meshes),
      materials: String(budget.materials),
      triangles: String(Math.round(budget.triangles)),
    });
  })();
}
