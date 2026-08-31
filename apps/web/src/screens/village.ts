import { EQUIPMENT_SLOTS, type PlayerProfile } from '@extramundum/shared';

import { api } from '../api.ts';
import { buildTag } from '../build-info.ts';
import { clear, el } from '../dom.ts';
import { t } from '../i18n.ts';
import { renderIcon } from '../ui/icon.ts';

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
  onRaid?: () => void,
  onInventory?: () => void,
  onDraft?: () => void,
): void {
  clear(root);

  const navButton = (labelKey: string, onClick: () => void) => {
    const button = el('button', { class: 'button', type: 'button' }, [t(labelKey)]);
    button.addEventListener('click', onClick);
    return button;
  };

  const stat = (labelKey: string, value: number) =>
    el('div', { class: 'stat' }, [
      el('span', { class: 'stat__label' }, [t(labelKey)]),
      el('span', { class: 'stat__value' }, [String(value)]),
    ]);

  /* Зов нового уровня. GDD §5.2.

     Спрашивается У СЕРВЕРА, а не выводится из профиля: сколько уровней
     ждёт разбора, знает он один — это разность заработанного по опыту
     и числа уже сделанных выборов. Считать её здесь значило бы завести
     второе место для кривой опыта. */
  const levelUp = el('div', { class: 'village__levelup' });

  if (onDraft !== undefined) {
    void api.draft().then(
      ({ draft }) => {
        if (draft.pending <= 0) return;
        const call = el('button', { class: 'button button--call', type: 'button' }, [
          t('draft.open'),
        ]);
        call.addEventListener('click', onDraft);
        levelUp.append(
          el('p', { class: 'village__levelupText' }, [t('draft.ready', { count: draft.pending })]),
          call,
        );
      },
      () => {
        // Молча: недоступный драфт не должен ронять деревню целиком.
        // Игрок увидит его при следующем заходе.
      },
    );
  }

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

      /* Место под зов драфта. Заполняется ОТДЕЛЬНЫМ запросом, потому что
         профиль здесь — тот, что прочитали при входе, а опыт меняется
         в рейде. Пустое место лучше устаревшего числа. */
      levelUp,

      // Восемь слотов экипировки. Что в них надето, показывает экран
      // снаряжения (M3a); здесь остаются иконки пустых слотов —
      // ни один ассет ещё не нарисован (ART-BIBLE §7).
      el(
        'div',
        { class: 'slots', 'aria-label': t('village.slots') },
        EQUIPMENT_SLOTS.map((slot) => renderIcon(`slot.${slot}`, 128, t(`slot.${slot}`))),
      ),

      /* Первый урок мира, и он стоит ровно там, где игрок впервые
         видит свой меч. §5.1 требует стартового оружия, LORE §2
         говорит «вывели за стену ни с чем» — противоречие снимается
         не молчанием, а тем, ЧЕЙ это меч.

         Показывается только на первом уровне: дальше игрок уже снял
         снаряжение с кого-то сам, и объяснять ему это незачем. */
      ...(player.level === 1
        ? [el('p', { class: 'village__first-blade' }, [t('village.firstBlade')])]
        : []),

      el('p', { class: 'village__stub' }, [t('village.stub')]),

      /* Метка сборки. Отвечает на один вопрос, который иначе нечем
         закрыть: «правка доехала или я смотрю на старое?» */
      el('p', { class: 'village__build', title: t('village.build') }, [buildTag()]),

      /* Вход в рейд. Кнопка ведёт к выбору зоны, а не сразу в бой:
         решение «куда идти» — часть игры, и снимать его с игрока
         значило бы вернуть арену из M2b, где зона была зашита.

         СТОИТ ПОСЛЕДНЕЙ, и это не косметика. Прежде она была
         в середине экрана, а под ней шли первый урок мира и заглушка —
         то есть главное действие оказалось выше зоны большого пальца
         из-за текста, который дописали позже. */
      el('div', { class: 'village__nav screen__actions' }, [
        ...(onInventory === undefined ? [] : [navButton('inventory.open', onInventory)]),
        ...(onRaid === undefined ? [] : [navButton('raid.enter', onRaid)]),
      ]),
    ]),
  );
}
