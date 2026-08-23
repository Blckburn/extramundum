import type { BattleStartResponse } from '@extramundum/shared';

import { api, ApiClientError } from '../api.ts';
import { mountBattle } from '../battle/mount.ts';
import { clear, el } from '../dom.ts';
import { t } from '../i18n.ts';

/**
 * Арена. GDD §3.2, §10, M2b.
 *
 * Экран отвечает ровно за одно: ОТКУДА берётся бой. Он просит сервер
 * его провести и передаёт готовый ответ в `mountBattle`. Ни одного
 * броска, ни одной формулы урона здесь нет и быть не может: движок
 * в браузер не попадает (инвариант 3), а состояние игрока читается
 * сервером из БД (инвариант 1).
 */

/**
 * Хеш экипировки. GDD §6.4: клиент присылает его, чтобы сервер мог
 * заметить рассинхрон.
 *
 * Предметов не существует до M3, поэтому набор пуст, а хеш пустого
 * набора — нули. Считать здесь что-то настоящее нечего: сверять хеш
 * будет с чем, когда появится экипировка, и тогда же он начнёт
 * вычисляться. Заглушка честнее выдуманной суммы.
 */
const EMPTY_LOADOUT_HASH = '0'.repeat(64);

export function renderArena(root: HTMLElement, onBack: () => void): void {
  clear(root);

  const canvas = el('canvas', { class: 'arena__canvas' }) as HTMLCanvasElement;
  const overlay = el('div', { class: 'arena__overlay' });
  const readout = el('p', { class: 'arena__readout' }, [t('arena.loading')]);
  const controls = el('div', { class: 'arena__controls' });
  const journalHost = el('div', { class: 'arena__journal' });

  const back = el('button', { class: 'button button--ghost', type: 'button' }, [t('action.back')]);

  root.append(
    el('main', { class: 'screen screen--arena' }, [
      el('div', { class: 'arena__stage' }, [canvas, overlay]),
      controls,
      journalHost,
      el('div', { class: 'arena__bar' }, [readout, back]),
    ]),
  );

  let stop: (() => void) | null = null;
  back.addEventListener('click', () => {
    stop?.();
    onBack();
  });

  void (async () => {
    let battle: BattleStartResponse;
    try {
      // В теле запроса нет ни одного числа о бойце, и схема таких полей
      // не содержит: состав читается сервером из БД по сессии.
      battle = await api.startBattle({
        zone: 'wastes',
        difficulty: 'normal',
        loadoutHash: EMPTY_LOADOUT_HASH,
      });
    } catch (err) {
      const key = err instanceof ApiClientError ? err.messageKey : 'error.internal';
      readout.textContent = t(key);
      return;
    }

    const mounted = await mountBattle({ canvas, overlay, controls, journalHost, readout }, battle);
    if (mounted === null) return;
    stop = () => mounted.stop();
  })();
}
