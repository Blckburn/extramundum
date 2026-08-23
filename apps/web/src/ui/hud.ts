import type { ActorIndex } from '@extramundum/shared';

import type { ActiveStatus, BattleState } from '../battle/state.ts';
import { el } from '../dom.ts';
import { t } from '../i18n.ts';

import { renderIcon } from './icon.ts';

/**
 * Полосы здоровья и иконки статусов. GDD §10.
 *
 * Иконки статусов адресуются НОМЕРОМ ЭКЗЕМПЛЯРА, а не идентификатором:
 * два кровотечения — это две записи со своими таймерами (GDD §4.4),
 * и слить их в одну иконку значило бы скрыть от игрока половину того,
 * что его убивает. Порядок — канонический `STATUS_IDS`, тот же, в каком
 * эффекты разрешаются: одинаковый бой обязан выглядеть одинаково.
 *
 * Разметка пересобирается на КАЖДОМ изменении показанного, а не на
 * каждом кадре. Изменений несколько в секунду, иконок меньше десятка,
 * и точечное обновление здесь было бы сложностью без выигрыша —
 * в отличие от кадра рендера, где она обязательна.
 */

export type HudView = {
  readonly element: HTMLElement;
  update(state: BattleState): void;
};

type Side = {
  readonly fill: HTMLElement;
  readonly value: HTMLElement;
  readonly statuses: HTMLElement;
  readonly root: HTMLElement;
};

function side(actor: ActorIndex): Side {
  const fill = el('span', { class: 'hud__fill' });
  const value = el('span', { class: 'hud__value' });
  const statuses = el('div', { class: 'hud__statuses' });

  const root = el('div', { class: `hud__side hud__side--${actor === 0 ? 'left' : 'right'}` }, [
    el('span', { class: 'hud__name' }, [
      actor === 0 ? t('battle.fighter.you') : t('battle.fighter.enemy'),
    ]),
    el('div', { class: 'hud__bar' }, [fill]),
    value,
    statuses,
  ]);

  return { fill, value, statuses, root };
}

export function renderHud(maxHp: readonly [number, number]): HudView {
  const sides: readonly [Side, Side] = [side(0), side(1)];
  const element = el('div', { class: 'hud' }, [sides[0].root, sides[1].root]);

  return {
    element,
    update(state: BattleState): void {
      for (let i = 0; i < 2; i++) {
        const view = sides[i as 0 | 1];
        const fighter = state.fighters[i as 0 | 1];
        const max = Math.max(1, maxHp[i] ?? 1);
        const hp = Math.max(0, Math.min(fighter.hp, max));

        view.fill.style.width = `${((hp / max) * 100).toFixed(1)}%`;
        view.value.textContent = t('battle.hp', { hp, max });
        view.root.classList.toggle('hud__side--dead', !fighter.alive);
        view.root.classList.toggle('hud__side--acting', state.acting === i);

        view.statuses.replaceChildren();
        for (const status of fighter.statuses) {
          view.statuses.append(statusChip(status, state.tick));
        }
      }
    },
  };
}

/**
 * Остаток длительности — ВЫЧИТАНИЕ, а не число из лога.
 *
 * Лог остатка не несёт, и расширять его формат ради подписи под иконкой
 * значило бы менять контракт с движком ради оформления. Величина
 * показательная: на исход она не влияет и в журнале не участвует.
 */
function remainingTicks(status: ActiveStatus, tick: number): number | null {
  if (status.duration < 0) return null;
  return Math.max(0, status.duration - (tick - status.appliedTick));
}

function statusChip(status: ActiveStatus, tick: number): HTMLElement {
  const left = remainingTicks(status, tick);
  const name = t(`status.${status.status}`);

  const children: (string | Node)[] = [renderIcon(`status.${status.status}`, 128, name)];

  if (status.stacks > 1) {
    children.push(
      el('span', { class: 'chip__stacks' }, [t('battle.status.stacks', { stacks: status.stacks })]),
    );
  }

  children.push(
    el('span', { class: 'chip__timer' }, [
      left === null ? t('battle.status.endless') : t('battle.status.duration', { ticks: left }),
    ]),
  );

  return el(
    'span',
    {
      class: 'chip',
      title: name,
      // Номер экземпляра в разметке: два кровотечения обязаны быть
      // различимы и в DOM, иначе тест не докажет, что их два.
      'data-instance': String(status.instance),
      'data-status': status.status,
    },
    children,
  );
}
