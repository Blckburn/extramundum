import type { PlayerProfile } from '@extramundum/shared';

import { api } from '../api.ts';
import { clear, el } from '../dom.ts';
import { t } from '../i18n.ts';
import { renderIcon } from '../ui/icon.ts';

/** GDD §5.3. В M0 показываются только как плейсхолдеры. */
const EQUIPMENT_SLOTS = [
  'weapon',
  'offhand',
  'helmet',
  'chest',
  'bracers',
  'boots',
  'amulet',
  'ring',
] as const;

/**
 * Заглушка деревни — граница этапа M0.
 *
 * Показывает то, что сервер прочитал из БД по сессии, и ничего больше.
 * Кузнец, лавка, инвентарь и вход в рейд — это M3 (GDD §11).
 */
export function renderVillage(
  root: HTMLElement,
  player: PlayerProfile,
  onSignedOut: () => void,
  onArena?: () => void,
): void {
  clear(root);

  const arenaButton = (onArena: () => void) => {
    const button = el('button', { class: 'button', type: 'button' }, [t('arena.enter')]);
    button.addEventListener('click', onArena);
    return button;
  };

  const stat = (labelKey: string, value: number) =>
    el('div', { class: 'stat' }, [
      el('span', { class: 'stat__label' }, [t(labelKey)]),
      el('span', { class: 'stat__value' }, [String(value)]),
    ]);

  const signOut = el('button', { class: 'button button--ghost', type: 'button' }, [
    t('auth.action.signOut'),
  ]);
  signOut.addEventListener('click', () => {
    void api.signOut().then(onSignedOut, onSignedOut);
  });

  root.append(
    el('main', { class: 'screen screen--village' }, [
      el('header', { class: 'village__header' }, [
        el('h1', { class: 'village__title' }, [t('village.title')]),
        signOut,
      ]),

      // Имя приходит из БД и вставляется текстовым узлом, не разметкой.
      el('p', { class: 'village__greeting' }, [
        t('village.greeting', { username: player.username }),
        // Номер в книге покойников (LORE §2). Показывается рядом с именем:
        // снаружи им представляются, и по нему видно стаж.
        el('span', { class: 'village__exile-number', title: t('village.exileNumber') }, [
          `#${player.exileNumber}`,
        ]),
      ]),

      el('div', { class: 'stats' }, [
        stat('village.stat.level', player.level),
        stat('village.stat.xp', player.xp),
        stat('village.stat.gold', player.gold),
        stat('village.stat.elo', player.elo),
      ]),

      // Восемь слотов экипировки — пока только иконки-плейсхолдеры.
      // Здесь они затем, чтобы система плейсхолдеров была видна, а не
      // только описана: ни один ассет ещё не нарисован (ART-BIBLE §7).
      // Инвентарь и надевание предметов — это M3.
      el(
        'div',
        { class: 'slots', 'aria-label': t('village.slots') },
        EQUIPMENT_SLOTS.map((slot) => renderIcon(`slot.${slot}`, 128, t(`slot.${slot}`))),
      ),

      // Вход на арену. В M2a там статичная сцена: воспроизведение боя —
      // это M2b, и заводить кнопку «в бой» раньше него значило бы обещать
      // игроку то, чего нет.
      ...(onArena === undefined ? [] : [arenaButton(onArena)]),

      el('p', { class: 'village__stub' }, [t('village.stub')]),
    ]),
  );
}
