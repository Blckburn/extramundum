import {
  EQUIPMENT_SLOTS,
  RARITIES,
  type EquipmentSlot,
  type InventoryResponse,
  type ItemAffixView,
  type ItemView,
  type Rarity,
} from '@extramundum/shared';

import { api, ApiClientError } from '../api.ts';
import { clear, el } from '../dom.ts';
import { t } from '../i18n.ts';
import { renderIcon } from '../ui/icon.ts';

/**
 * Снаряжение: инвентарь, стеш, экипировка. GDD §5.3, §6.3, §6.4.
 *
 * КЛИЕНТ НЕ СЧИТАЕТ НИЧЕГО. Числа предмета приходят уже с учётом ilvl,
 * пометка «аффикс не учитывается» приходит от сервера, шанс победы
 * и дельты статов считает сервер тремя сотнями прогонов. Здесь только
 * показ и отправка идентификаторов.
 *
 * Три вещи на экране — прямое лечение v1.0, где стеш на сто слотов
 * не имел ни фильтров, ни сортировки, ни защиты от продажи, и это было
 * главным источником раздражения: фильтр по редкости, сортировка,
 * замок.
 */

type Sort = 'rarity' | 'ilvl' | 'slot';
type Tab = 'inv' | 'stash';

/** Порядок редкостей — из контракта: от худшей к лучшей. */
const RARITY_ORDER = new Map(RARITIES.map((rarity, index) => [rarity, index]));
const SLOT_ORDER = new Map(EQUIPMENT_SLOTS.map((slot, index) => [slot, index]));

export function renderInventory(root: HTMLElement, onBack: () => void): void {
  clear(root);

  const head = el('div', { class: 'inv__head' });
  const portraitCanvas = el('canvas', { class: 'inv__portrait' }) as HTMLCanvasElement;
  const slotsRow = el('div', { class: 'inv__slots' });
  const controls = el('div', { class: 'inv__controls' });
  const grid = el('div', { class: 'inv__grid' });
  const detail = el('aside', { class: 'inv__detail' });
  const notice = el('p', { class: 'inv__notice', role: 'status' });

  const back = el('button', { class: 'button button--ghost', type: 'button' }, [t('action.back')]);
  back.addEventListener('click', () => {
    portrait?.stop();
    onBack();
  });

  root.append(
    el('main', { class: 'screen screen--inventory' }, [
      el('header', { class: 'inv__top' }, [
        el('h1', { class: 'inv__title' }, [t('inventory.title')]),
        head,
      ]),
      el('div', { class: 'inv__worn' }, [portraitCanvas, slotsRow]),
      controls,
      el('div', { class: 'inv__body' }, [grid, detail]),
      el('div', { class: 'inv__bar' }, [notice, back]),
    ]),
  );

  let data: InventoryResponse | null = null;
  let tab: Tab = 'inv';
  let sort: Sort = 'rarity';
  const rarityFilter = new Set<Rarity>();
  let selectedId: string | null = null;
  /** Растёт на каждый запрос превью: ответ на устаревший игнорируется. */
  let previewToken = 0;
  /** Портрет с надетым. three.js — динамическим импортом, как на арене. */
  let portrait: { show(worn: ReadonlySet<EquipmentSlot>): void; stop(): void } | null = null;

  void (async () => {
    const { mountPortrait } = await import('../render/portrait.ts');
    if (!portraitCanvas.isConnected) return;
    portrait = mountPortrait(portraitCanvas);
    showWorn();
  })();

  /**
   * §5.3: «восемь слотов, и ВСЕ ВИДНЫ НА РИГЕ». Пустой слот прячет свой
   * узел, занятый показывает — без этого обещание остаётся словами.
   */
  function showWorn(): void {
    if (portrait === null || data === null) return;
    portrait.show(new Set(Object.keys(data.equipped) as EquipmentSlot[]));
  }

  const refresh = async (): Promise<void> => {
    try {
      data = await api.items();
    } catch (err) {
      notice.textContent = t(err instanceof ApiClientError ? err.messageKey : 'error.internal');
      return;
    }
    draw();
  };

  /* ─────────────────────────────── отрисовка ─────────────────────────── */

  function draw(): void {
    if (data === null) return;

    const used = data.items.filter((item) => item.container === tab).length;
    const max = tab === 'inv' ? data.capacity.inv : data.capacity.stash;

    clear(head);
    head.append(
      el('span', { class: 'inv__gold' }, [t('inventory.gold', { gold: data.gold })]),
      el('span', { class: 'inv__capacity' }, [t('inventory.capacity', { used, max })]),
    );

    showWorn();
    drawSlots();
    drawControls();
    drawGrid();
    drawDetail();
  }

  function drawSlots(): void {
    if (data === null) return;
    clear(slotsRow);
    slotsRow.append(el('span', { class: 'inv__label' }, [t('inventory.equipped')]));

    for (const slot of EQUIPMENT_SLOTS) {
      const itemId = data.equipped[slot];
      const item = itemId === undefined ? undefined : data.items.find((i) => i.id === itemId);

      const button = el(
        'button',
        {
          class: `inv__slot${item === undefined ? ' inv__slot--empty' : ` inv__slot--${item.rarity}`}`,
          type: 'button',
          title: item === undefined ? t(`slot.${slot}`) : t(`item.${item.baseKey}`),
        },
        [renderIcon(item === undefined ? `slot.${slot}` : item.baseKey, 128, t(`slot.${slot}`))],
      );

      button.addEventListener('click', () => {
        if (item === undefined) return;
        selectedId = item.id;
        draw();
      });
      slotsRow.append(button);
    }
  }

  function drawControls(): void {
    clear(controls);

    for (const value of ['inv', 'stash'] as const) {
      const button = el(
        'button',
        { class: `button button--small${tab === value ? ' button--active' : ''}`, type: 'button' },
        [t(`inventory.${value}`)],
      );
      button.addEventListener('click', () => {
        tab = value;
        draw();
      });
      controls.append(button);
    }

    controls.append(el('span', { class: 'inv__label' }, [t('inventory.filter.rarity')]));
    for (const rarity of RARITIES) {
      const active = rarityFilter.has(rarity);
      const button = el(
        'button',
        {
          class: `button button--small inv__rarity inv__rarity--${rarity}${active ? ' button--active' : ''}`,
          type: 'button',
        },
        [t(`rarity.${rarity}`)],
      );
      button.addEventListener('click', () => {
        if (active) rarityFilter.delete(rarity);
        else rarityFilter.add(rarity);
        draw();
      });
      controls.append(button);
    }

    const sortSelect = el('select', { class: 'inv__sort', 'aria-label': t('inventory.sort') });
    for (const value of ['rarity', 'ilvl', 'slot'] as const) {
      const option = el('option', { value }, [t(`inventory.sort.${value}`)]);
      if (sort === value) option.setAttribute('selected', 'selected');
      sortSelect.append(option);
    }
    sortSelect.addEventListener('change', () => {
      sort = (sortSelect as HTMLSelectElement).value as Sort;
      draw();
    });
    controls.append(sortSelect);

    /* Массовая продажа. Заблокированные не продаются никогда — это
       держит сервер, а не подтверждение здесь.

       Кнопка НЕАКТИВНА, пока редкости не выбраны. Пустой фильтр в этом
       экране означает «показать все», и если бы продажа читала его так же,
       одно нажатие сносило бы весь стеш — необратимо и без явного
       намерения. Разрушающее действие требует выбора, а не умолчания. */
    const sell = el('button', { class: 'button button--small button--danger', type: 'button' }, [
      rarityFilter.size === 0
        ? t('inventory.action.sellPick')
        : t('inventory.action.sell', { count: rarityFilter.size }),
    ]) as HTMLButtonElement;
    sell.disabled = rarityFilter.size === 0;
    sell.addEventListener('click', () => void sellSelected());
    controls.append(sell);
  }

  function visibleItems(): readonly ItemView[] {
    if (data === null) return [];
    const filtered = data.items.filter(
      (item) =>
        item.container === tab && (rarityFilter.size === 0 || rarityFilter.has(item.rarity)),
    );

    return [...filtered].sort((a, b) => {
      if (sort === 'ilvl') return b.ilvl - a.ilvl;
      if (sort === 'slot') return (SLOT_ORDER.get(a.slot) ?? 0) - (SLOT_ORDER.get(b.slot) ?? 0);
      return (RARITY_ORDER.get(b.rarity) ?? 0) - (RARITY_ORDER.get(a.rarity) ?? 0);
    });
  }

  function drawGrid(): void {
    clear(grid);
    const list = visibleItems();

    if (list.length === 0) {
      grid.append(el('p', { class: 'inv__empty' }, [t('inventory.empty')]));
      return;
    }

    for (const item of list) {
      const cell = el(
        'button',
        {
          class: `inv__cell inv__cell--${item.rarity}${item.id === selectedId ? ' inv__cell--selected' : ''}`,
          type: 'button',
          title: t(`item.${item.baseKey}`),
        },
        [
          renderIcon(item.baseKey, 128, t(`item.${item.baseKey}`)),
          el('span', { class: 'inv__cell-ilvl' }, [String(item.ilvl)]),
          ...(item.locked
            ? [el('span', { class: 'inv__cell-lock', title: t('inventory.locked') }, ['⊘'])]
            : []),
        ],
      );
      cell.addEventListener('click', () => {
        selectedId = item.id;
        draw();
      });
      grid.append(cell);
    }
  }

  function selected(): ItemView | null {
    if (data === null || selectedId === null) return null;
    return data.items.find((item) => item.id === selectedId) ?? null;
  }

  function drawDetail(): void {
    clear(detail);
    const item = selected();
    if (item === null || data === null) return;

    detail.append(
      el('h2', { class: `inv__name inv__name--${item.rarity}` }, [t(`item.${item.baseKey}`)]),
      el('p', { class: 'inv__sub' }, [
        `${t(`rarity.${item.rarity}`)} · ${t('item.ilvl', { ilvl: item.ilvl })} · ${t(`slot.${item.slot}`)}`,
      ]),
    );

    /* Числа предмета — УЖЕ с учётом ilvl, посчитанные сервером.
       Показывать базу там, где в бою участвует другое число, — это
       пункт 4 аудита v1.0. */
    const d = item.derived;
    const lines: string[] = [];
    if (d.dmgMin !== undefined && d.dmgMax !== undefined) {
      lines.push(t('item.dmg', { min: d.dmgMin, max: d.dmgMax }));
    }
    if (d.armor !== undefined) lines.push(t('item.armor', { armor: d.armor }));
    if (d.blockChance !== undefined && d.blockReduction !== undefined) {
      lines.push(
        t('item.block', {
          chance: Math.round(d.blockChance * 100),
          reduction: Math.round(d.blockReduction * 100),
        }),
      );
    }
    if (d.statusPower !== undefined) {
      lines.push(t('item.statusPower', { percent: Math.round((d.statusPower - 1) * 100) }));
    }
    if (lines.length > 0) {
      detail.append(
        el(
          'ul',
          { class: 'inv__stats' },
          lines.map((line) => el('li', {}, [line])),
        ),
      );
    }

    if (item.affixes.length > 0) {
      const budget = data.stats.mightBudget;
      detail.append(
        el(
          'ul',
          { class: 'inv__affixes' },
          item.affixes.map((affix) => affixRow(affix, budget)),
        ),
      );
    }

    detail.append(actions(item));
    detail.append(el('div', { class: 'inv__preview' }, [t('preview.loading')]));
    void loadPreview(item);
  }

  function affixRow(affix: ItemAffixView, budget: number): HTMLElement {
    const text =
      affix.family === 'might'
        ? t('affix.might', { percent: Math.round(affix.value * 1000) / 10 })
        : t('affix.strength', { value: affix.value });

    const children: (string | Node)[] = [
      el('span', { class: 'inv__affix-text' }, [text]),
      el('span', { class: 'inv__affix-tier' }, [affix.tier]),
    ];

    // Пометку ставит СЕРВЕР: он один знает весь надетый набор.
    if (affix.counted === false) {
      children.push(el('span', { class: 'inv__affix-cut' }, [t('affix.notCounted', { budget })]));
    }

    return el(
      'li',
      { class: affix.counted === false ? 'inv__affix inv__affix--cut' : 'inv__affix' },
      children,
    );
  }

  function actions(item: ItemView): HTMLElement {
    const row = el('div', { class: 'inv__actions' });

    const add = (label: string, run: () => Promise<void>): void => {
      const button = el('button', { class: 'button button--small', type: 'button' }, [
        label,
      ]) as HTMLButtonElement;
      button.addEventListener('click', () => {
        // Кнопка гасится на время запроса: два «надеть» подряд
        // отправили бы вторую команду поверх незавершённой первой.
        button.disabled = true;
        void run()
          .then(refresh)
          .catch((err: unknown) => {
            notice.textContent = t(
              err instanceof ApiClientError ? err.messageKey : 'error.internal',
            );
          });
      });
      row.append(button);
    };

    if (item.container === 'equipped') {
      add(t('inventory.action.unequip'), () => api.unequip({ slot: item.slot }));
    } else {
      add(t('inventory.action.equip'), () => api.equip({ itemId: item.id }));
      add(
        item.container === 'inv' ? t('inventory.action.toStash') : t('inventory.action.toInv'),
        () => api.moveItem({ itemId: item.id, to: item.container === 'inv' ? 'stash' : 'inv' }),
      );
    }

    add(item.locked ? t('inventory.action.unlock') : t('inventory.action.lock'), () =>
      api.lockItem({ itemId: item.id, locked: !item.locked }),
    );

    return row;
  }

  /* ──────────────────────────────── превью ───────────────────────────── */

  /**
   * Самая ценная функция интерфейса из §6.4: в автобаттлере игрок
   * не может «сыграть лучше», поэтому вопрос «стало ли лучше?» должен
   * получать честный численный ответ.
   *
   * Считает СЕРВЕР. Ответ на устаревший запрос отбрасывается по токену:
   * иначе быстрый перебор предметов показал бы числа от предыдущего.
   */
  async function loadPreview(item: ItemView): Promise<void> {
    const box = detail.querySelector('.inv__preview');
    if (box === null || item.container === 'equipped') {
      box?.replaceChildren();
      return;
    }

    const token = ++previewToken;
    try {
      const result = await api.preview({
        zone: 'wastes',
        difficulty: 'normal',
        loadoutHash: '0'.repeat(64),
        runs: 300,
        change: { kind: 'equip', itemId: item.id },
      });
      if (token !== previewToken || selectedId !== item.id) return;

      const deltas = result.deltas ?? {};
      const keys = Object.keys(deltas);
      const before = Math.round((result.baseWinRate ?? result.winRate) * 100);
      const after = Math.round(result.winRate * 100);

      box.replaceChildren(
        el('h3', { class: 'inv__preview-title' }, [t('preview.title')]),
        el('p', { class: 'inv__winrate' }, [t('preview.winRate', { before, after })]),
        keys.length === 0
          ? el('p', { class: 'inv__delta-none' }, [t('preview.noChange')])
          : el(
              'ul',
              { class: 'inv__deltas' },
              keys.map((key) =>
                el(
                  'li',
                  { class: (deltas[key] ?? 0) > 0 ? 'inv__delta--up' : 'inv__delta--down' },
                  [
                    `${t(`stat.${key}`)} ${(deltas[key] ?? 0) > 0 ? '+' : ''}${Math.round((deltas[key] ?? 0) * 100) / 100}`,
                  ],
                ),
              ),
            ),
      );
    } catch {
      if (token === previewToken) box.replaceChildren();
    }
  }

  /* ─────────────────────────── массовая продажа ──────────────────────── */

  async function sellSelected(): Promise<void> {
    if (rarityFilter.size === 0) return;
    const rarities = [...rarityFilter];
    const names = rarities.map((rarity) => t(`rarity.${rarity}`)).join(', ');
    if (!globalThis.confirm(t('inventory.sell.confirm', { rarities: names }))) return;

    try {
      const result = await api.sellItems({ rarities, from: tab });
      notice.textContent =
        result.sold === 0
          ? t('inventory.sell.none')
          : `${t('inventory.sell.done', { sold: result.sold, gold: result.gold })} · ${t('inventory.sell.provisional')}`;
      selectedId = null;
      await refresh();
    } catch (err) {
      notice.textContent = t(err instanceof ApiClientError ? err.messageKey : 'error.internal');
    }
  }

  void refresh();
}
