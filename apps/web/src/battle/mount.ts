import type { BattleEvent, BattleStartResponse } from '@extramundum/shared';

import { el } from '../dom.ts';
import { t } from '../i18n.ts';
import { renderHud } from '../ui/hud.ts';
import { renderJournal } from '../ui/journal.ts';

import { stateAt } from './state.ts';

/**
 * Показ готового боя: сцена, эффекты, HUD, журнал, органы управления.
 * GDD §3.2, §10.
 *
 * ОТКУДА ВЗЯЛСЯ БОЙ, ЭТОТ МОДУЛЬ НЕ ЗНАЕТ. Он получает уже посчитанный
 * `BattleStartResponse` и показывает его. Разделение не ради «удобства
 * тестирования»: экран арены ходит на сервер, а пробная страница
 * `apps/web/dev/battle.html` берёт записанный лог — и обе обязаны
 * показывать бой ОДНИМ И ТЕМ ЖЕ кодом. Иначе проверенное на пробной
 * странице ничего не говорит о том, что увидит игрок.
 *
 * Клиент здесь по-прежнему не считает ничего: ни урона, ни шансов,
 * ни исхода. Движок в браузер не попадает (инвариант 3).
 */

export type BattleSurface = {
  readonly canvas: HTMLCanvasElement;
  /** Слой поверх холста: цифры урона и полосы здоровья. */
  readonly overlay: HTMLElement;
  readonly controls: HTMLElement;
  readonly journalHost: HTMLElement;
  /** Строка с живыми числами бюджета. */
  readonly readout: HTMLElement;
};

export type MountedBattle = {
  /** Живые вызовы отрисовки за последний кадр — для пробных замеров. */
  drawCalls(): number;
  stop(): void;
};

export async function mountBattle(
  surface: BattleSurface,
  battle: BattleStartResponse,
): Promise<MountedBattle | null> {
  const { canvas, overlay, controls, journalHost, readout } = surface;

  /* three.js и проигрыватель — динамическим импортом. Бюджет GDD §3.4
     требует первый кадр поселения быстрее двух секунд на 4G, а движок
     рендера — самая тяжёлая часть клиента: игрок, не пошедший в бой,
     не должен его качать вовсе. */
  const [{ mountBattleScene }, { BattlePlayer }, { animations }] = await Promise.all([
    import('../render/index.ts'),
    import('./player.ts'),
    import('@extramundum/data'),
  ]);

  // Экран мог смениться, пока грузился чанк: монтировать рендер
  // в отсоединённый canvas значит оставить висеть контекст WebGL.
  if (!canvas.isConnected) return null;

  const mounted = mountBattleScene(canvas);
  const player = new BattlePlayer({
    scene: mounted.scene,
    log: battle.log,
    numberText,
  });

  overlay.append(player.numbers.element);

  const hud = renderHud(battle.maxHp);
  overlay.append(hud.element);

  /* ── итог показывается ТОЛЬКО когда бой досмотрен.

     Сервер прислал исход сразу — он нужен для записи в базу, — но
     написать «Победа» над журналом в первую секунду значит отменить
     смысл просмотра. То же самое делает и сам журнал: строка события,
     которого ещё не было, не показывается вовсе. */
  const summary = el('p', { class: 'arena__summary', hidden: 'hidden' });
  journalHost.append(summary);

  const journal = renderJournal(battle.log, (index) => {
    player.setPaused(true);
    player.seekToEvent(index);
    syncControls();
  });
  journalHost.append(journal.element);

  mounted.setResizeHook((width, height) => player.resize(width, height));
  mounted.setFrameHook((dt) => player.advance(dt));

  /* ── органы управления. Скорости берутся ИЗ ДАННЫХ (animations.json),
     а не из литералов здесь: набор скоростей — это дизайн, а не код. */
  const playPause = el('button', { class: 'button button--small', type: 'button' });
  playPause.addEventListener('click', () => {
    player.setPaused(!player.paused);
    syncControls();
  });

  const restart = el('button', { class: 'button button--small', type: 'button' }, [
    t('battle.control.restart'),
  ]);
  restart.addEventListener('click', () => {
    player.seek(0);
    player.setPaused(false);
    syncControls();
  });

  const scrub = el('input', {
    class: 'arena__scrub',
    type: 'range',
    min: '0',
    max: String(Math.round(player.totalMs)),
    step: '10',
    value: '0',
    'aria-label': t('battle.control.scrub'),
  }) as HTMLInputElement;
  scrub.addEventListener('input', () => {
    player.setPaused(true);
    player.seek(Number(scrub.value));
    syncControls();
  });

  const speedButtons: HTMLButtonElement[] = [];
  for (const speed of animations.speeds) {
    const button = el('button', { class: 'button button--small', type: 'button' }, [
      speed === 0 ? t('battle.control.instant') : t('battle.control.speed', { speed }),
    ]) as HTMLButtonElement;
    button.addEventListener('click', () => {
      player.setSpeed(speed);
      if (speed === 0) player.setPaused(true);
      syncControls();
    });
    speedButtons.push(button);
  }

  controls.append(playPause, restart, ...speedButtons, scrub);

  function syncControls(): void {
    playPause.textContent = player.paused ? t('battle.control.play') : t('battle.control.pause');
    scrub.value = String(Math.round(player.clockMs));
    for (let i = 0; i < speedButtons.length; i++) {
      const button = speedButtons[i];
      const speed = animations.speeds[i];
      if (button === undefined || speed === undefined) continue;
      button.classList.toggle('button--active', speed !== 0 && player.speed === speed);
    }
  }

  /* ── перерисовка по изменению показанного, а не по кадру.
     HUD и журнал меняются несколько раз в секунду; трогать их
     шестьдесят раз в секунду значило бы делать работу впустую. */
  const refresh = (): void => {
    hud.update(stateAt(battle.log, player.shownCount, battle.maxHp));
    // Прокрутка журнала — только пока бой идёт. На паузе игрок читает,
    // и дёргать под ним список значит мешать ровно тому, ради чего
    // журнал существует.
    journal.reveal(player.shownCount, !player.paused);
    scrub.value = String(Math.round(player.clockMs));

    // Живое число вызовов отрисовки — от самого рендера, ВО ВРЕМЯ БОЯ.
    // Замер покоя доказывал бы только то, что покой дёшев.
    const budget = mounted.measure();
    readout.textContent = t('arena.budget', {
      draws: String(mounted.drawCalls() || budget.meshes),
      materials: String(budget.materials),
      triangles: String(Math.round(budget.triangles)),
    });

    if (player.finished && summary.hidden) {
      // Итог — ОТ СЕРВЕРА, а не выведен здесь: клиент не решает,
      // кто победил, даже когда это очевидно из последнего события.
      summary.hidden = false;
      summary.replaceChildren(
        document.createTextNode(
          battle.outcome.winner === null
            ? t('battle.outcome.unfinished')
            : battle.outcome.winner === 0
              ? t('battle.outcome.win')
              : t('battle.outcome.loss'),
        ),
        ...(battle.provisional
          ? [el('span', { class: 'arena__note' }, [t('battle.provisional')])]
          : []),
      );
    }
  };

  player.onChange(refresh);
  refresh();
  syncControls();

  return {
    drawCalls: () => mounted.drawCalls(),
    stop() {
      mounted.setFrameHook(null);
      mounted.setResizeHook(null);
      player.dispose();
      mounted.stop();
    },
  };
}

/**
 * Текст всплывающего числа. Инвариант 6: строки — из словаря, а числа —
 * ИЗ ЛОГА. Клиент не складывает и не выводит ни одной величины.
 *
 * `null` означает «числу здесь не место»: событие без величины не должно
 * рисовать пустой прямоугольник над головой.
 */
function numberText(event: BattleEvent): string | null {
  switch (event.t) {
    case 'damage':
      return t('battle.damage', { amount: event.amount });
    case 'dodge':
      return t('battle.dodge.short');
    case 'block':
      return t('battle.block.amount', { amount: event.mitigated });
    case 'status_tick':
      return event.amount === undefined ? null : t('battle.damage', { amount: event.amount });
    default:
      return null;
  }
}
