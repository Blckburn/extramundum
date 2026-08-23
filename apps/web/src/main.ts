import { api, ApiClientError } from './api.ts';
import { clear, el } from './dom.ts';
import { getLocale, setLocale, t } from './i18n.ts';
import { renderArena } from './screens/arena.ts';
import { renderAuth } from './screens/auth.ts';
import { renderVillage } from './screens/village.ts';

import type { MeResponse } from '@extramundum/shared';

const root = document.querySelector<HTMLElement>('#app');
if (root === null) throw new Error('#app не найден');

setLocale(getLocale());
document.title = t('app.title');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function showStatus(messageKey: string): void {
  clear(root!);
  root!.append(el('main', { class: 'screen' }, [el('p', { class: 'loading' }, [t(messageKey)])]));
}

function showError(messageKey: string, onRetry: () => void): void {
  clear(root!);

  const retry = el('button', { class: 'button', type: 'button' }, [t('action.retry')]);
  retry.addEventListener('click', onRetry);

  root!.append(
    el('main', { class: 'screen screen--auth' }, [
      el('div', { class: 'card' }, [
        el('p', { class: 'form__error', role: 'alert' }, [t(messageKey)]),
        retry,
      ]),
    ]),
  );
}

/**
 * Первая загрузка с повторами.
 *
 * Web Service на плане free засыпает после 15 минут простоя и просыпается
 * десятками секунд: первые запросы отваливаются по сети или отвечают 502.
 * Это не ошибка приложения, поэтому повторяем — но повторяем ограниченно
 * и обязательно говорим игроку, что происходит.
 *
 * Ошибки 4xx повторять бессмысленно: они не рассосутся.
 */
async function loadProfile(): Promise<MeResponse | null> {
  const delays = [0, 2_000, 4_000, 8_000, 15_000, 20_000];
  let lastError: unknown;

  for (const delay of delays) {
    if (delay > 0) {
      showStatus('app.waking');
      await sleep(delay);
    }

    try {
      return await api.me();
    } catch (err) {
      lastError = err;
      const retriable = err instanceof ApiClientError && (err.status === 0 || err.status >= 500);
      if (!retriable) throw err;
    }
  }

  throw lastError;
}

/**
 * Маршрутизации в M0 нет: состояний ровно два — есть сессия или нет.
 * Источник правды о том, кто вошёл, — сервер (GET /me), а не localStorage.
 * Клиент не хранит и не может подделать признак «я залогинен».
 */
async function route(): Promise<void> {
  showStatus('app.loading');

  let me: MeResponse | null;
  try {
    me = await loadProfile();
  } catch (err) {
    // Экран ошибки с кнопкой повтора. Вечная «Загрузка…» — это не
    // состояние приложения, а отсутствие обработки ошибки.
    const messageKey = err instanceof ApiClientError ? err.messageKey : 'error.internal';
    showError(messageKey, () => void route());
    return;
  }

  if (me === null) {
    renderAuth(root!, () => void route());
    return;
  }

  const player = me.player;
  const village = (): void =>
    renderVillage(
      root!,
      player,
      () => void route(),
      () => renderArena(root!, village),
    );
  village();
}

void route();
