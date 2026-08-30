import type { RunFightResponse, RunView, ZoneCard } from '@extramundum/shared';

import { api, ApiClientError } from '../api.ts';
import { mountBattle } from '../battle/mount.ts';
import { clear, el } from '../dom.ts';
import { plural, t } from '../i18n.ts';
import { renderIcon } from '../ui/icon.ts';

/**
 * Рейд: выбор зоны, бой и решение об эвакуации. GDD §7.2, §7.3, §7.4.
 *
 * ЭКРАН НЕ СЧИТАЕТ НИЧЕГО. Уровень врага, множитель матчапа, множитель
 * лута, «можно ли уйти» — всё приходит с сервера готовыми числами.
 * Формула §7.3 живёт в одном месте, и второго её места здесь нет:
 * разойдись они, игрок увидел бы одно, а получил другое.
 *
 * Показ боя переиспользует `mountBattle` из M2b без изменений: откуда
 * взялся лог, показу знать незачем.
 */

type Surface = {
  readonly root: HTMLElement;
  readonly onBack: () => void;
};

export function renderRaid(root: HTMLElement, onBack: () => void): void {
  void render({ root, onBack });
}

async function render(surface: Surface): Promise<void> {
  clear(surface.root);
  const host = el('main', { class: 'screen screen--raid' });
  surface.root.append(host);

  const back = el('button', { class: 'button button--ghost', type: 'button' }, [t('action.back')]);
  back.addEventListener('click', surface.onBack);

  let zones: readonly ZoneCard[] = [];
  let run: RunView | null = null;

  const refresh = async (): Promise<void> => {
    const body = await api.zones();
    zones = body.zones;
    run = body.activeRun;
  };

  const fail = (err: unknown): void => {
    const key = err instanceof ApiClientError ? err.messageKey : 'error.internal';
    clear(host);
    host.append(el('p', { class: 'raid__error' }, [t(key)]), back);
  };

  try {
    await refresh();
  } catch (err) {
    fail(err);
    return;
  }

  /** Перерисовать целиком. Состояние приходит с сервера, локального нет. */
  const draw = (): void => {
    clear(host);
    host.className = 'screen screen--raid';
    host.append(run === null ? zonePicker() : runPanel(run));
    host.append(back);
  };

  /* ─────────────────────────── выбор зоны ─────────────────────────── */

  function zonePicker(): HTMLElement {
    return el('section', { class: 'raid__zones' }, [
      el('h1', { class: 'screen__title' }, [t('raid.title')]),
      el('p', { class: 'raid__lead' }, [t('raid.lead')]),
      el(
        'ul',
        { class: 'zones' },
        zones.map((zone) => zoneCard(zone)),
      ),
    ]);
  }

  function zoneCard(zone: ZoneCard): HTMLElement {
    const card = el('li', { class: zone.unlocked ? 'zone' : 'zone zone--locked' }, [
      el('div', { class: 'zone__head' }, [
        renderIcon(`zone.${zone.id}`, 128, t(`zone.${zone.id}`)),
        el('div', {}, [
          el('h2', { class: 'zone__name' }, [t(`zone.${zone.id}`)]),
          el('p', { class: 'zone__sub' }, [
            [
              t('zone.levels', { min: zone.levels[0], max: zone.levels[1] }),
              t('zone.enemyArmor', { armor: t(`armorClass.${zone.armorClass}`) }),
              // Восстановление — ВХОД В РЕШЕНИЕ «идти дальше», а не
              // служебное число, и оно зонное. Написать «между боями
              // четверть» один раз на все зоны значило бы соврать
              // на первой же из них.
              t('zone.restore', { percent: Math.round(zone.hpRestore * 100) }),
            ].join(' · '),
          ]),
        ]),
      ]),
      /* Плашка матчапа. §4.3: «ничего не спрятано». Число считает
         сервер — клиенту таблицу матчапов не показывают и не дают
         вывести самому. */
      matchupPlate(zone.matchup),
      el(
        'ul',
        { class: 'zone__monsters' },
        [...zone.monsters, zone.boss].map((key) =>
          el(
            'li',
            { class: key === zone.boss ? 'zone__monster zone__monster--boss' : 'zone__monster' },
            [
              t(`monster.${key}`),
              ...(key === zone.boss
                ? [el('span', { class: 'zone__boss' }, [t('monster.boss')])]
                : []),
            ],
          ),
        ),
      ),
      // Запертая зона показывает ЗАМОК И УРОВЕНЬ, а не пустое место:
      // «сюда нельзя» без «а когда можно» — это тупик, а не правило.
      zone.unlocked
        ? el('div', { class: 'zone__difficulties' }, difficultyButtons(zone))
        : el('p', { class: 'zone__locked' }, [t('zone.locked', { level: zone.minLevel })]),
    ]);
    return card;
  }

  function difficultyButtons(zone: ZoneCard): HTMLElement[] {
    return (['normal', 'dangerous', 'nightmare'] as const).map((difficulty) => {
      const rules = zone.difficulties[difficulty];
      const button = el('button', { class: 'button button--small', type: 'button' }, [
        /* Сила тира названа числом. До правки §7.3 тир двигал уровень
           врага, и разницу было видно по нему; теперь уровень одинаков
           у всех тиров, и без множителя «Опасная» отличалась бы
           от «Обычной» только словом. */
        `${t(`difficulty.${difficulty}`)} · ${t('raid.enemyLevel', { level: rules.enemyLevel })}` +
          (rules.power === 1
            ? ''
            : ` · ${t('raid.enemyPower', { value: rules.power.toFixed(2) })}`) +
          ` · ${t('raid.lootMultiplier', { value: rules.lootMultiplier })}`,
      ]) as HTMLButtonElement;

      button.addEventListener('click', () => {
        button.disabled = true;
        void api
          .startRun({ zone: zone.id, difficulty })
          .then(async () => {
            await refresh();
            draw();
          })
          .catch(fail);
      });
      return button;
    });
  }

  function matchupPlate(matchup: number | null): HTMLElement {
    if (matchup === null) {
      // Смешанная зона одного числа не имеет и не должна его придумывать.
      return el('p', { class: 'zone__matchup zone__matchup--mixed' }, [t('raid.matchup.mixed')]);
    }
    const tone = matchup > 1 ? 'good' : matchup < 1 ? 'bad' : 'even';
    return el('p', { class: `zone__matchup zone__matchup--${tone}` }, [
      t('raid.matchup', { value: matchup.toFixed(2) }),
    ]);
  }

  /* ────────────────────────── панель забега ───────────────────────── */

  function runPanel(current: RunView): HTMLElement {
    const hpFraction = current.maxHp === 0 ? 0 : current.hp / current.maxHp;

    const panel = el('section', { class: 'raid__run' }, [
      el('h1', { class: 'screen__title' }, [t(`zone.${current.zone}`)]),
      el('p', { class: 'raid__lead' }, [
        `${t(`difficulty.${current.difficulty}`)} · ${t('raid.progress', {
          done: current.fightIndex,
          total: current.fightsTotal,
        })} · ${t('raid.lootMultiplier', { value: current.lootMultiplier })} · ${t('zone.restore', {
          percent: Math.round(current.hpRestore * 100),
        })}`,
      ]),

      el('div', { class: 'raid__hp' }, [
        el('div', { class: 'raid__hpbar' }, [
          el('span', { class: 'raid__hpfill', style: `width:${Math.round(hpFraction * 100)}%` }),
        ]),
        el('span', { class: 'raid__hptext' }, [
          t('raid.hp', { hp: current.hp, maxHp: current.maxHp }),
        ]),
      ]),

      nextBlock(current),
      bagBlock(current),
      actions(current),
    ]);
    return panel;
  }

  function nextBlock(current: RunView): HTMLElement {
    if (current.next === null) return el('p', { class: 'raid__next' }, [t('raid.finished')]);

    const enemy = current.next;
    return el('div', { class: 'raid__next' }, [
      el('h2', { class: 'raid__subtitle' }, [t('raid.next')]),
      el('p', { class: 'raid__enemy' }, [
        t(`monster.${enemy.key}`),
        ...(enemy.boss ? [el('span', { class: 'zone__boss' }, [t('monster.boss')])] : []),
      ]),
      el('p', { class: 'raid__enemySub' }, [
        `${t('raid.enemyLevel', { level: enemy.level })} · ${t('zone.enemyArmor', {
          armor: t(`armorClass.${enemy.armorClass}`),
        })}`,
      ]),
      matchupPlate(enemy.matchup),
    ]);
  }

  function bagBlock(current: RunView): HTMLElement {
    if (current.bag.length === 0) {
      return el('p', { class: 'raid__bag raid__bag--empty' }, [t('raid.bag.empty')]);
    }

    return el('div', { class: 'raid__bag' }, [
      el('h2', { class: 'raid__subtitle' }, [t('raid.bag', { count: current.bag.length })]),
      // Сумка показывается ЦЕЛИКОМ: игрок видел, как падал лут (§7.2).
      // Спрятать её значило бы убрать из решения половину ставки.
      el(
        'ul',
        { class: 'raid__bagList' },
        current.bag.map((item) =>
          el('li', { class: `raid__bagItem raid__bagItem--${item.rarity}` }, [
            renderIcon(item.baseKey, 128, t(`item.${item.baseKey}`)),
            el('span', {}, [t(`item.${item.baseKey}`)]),
            el('span', { class: 'raid__bagIlvl' }, [t('item.level.short', { ilvl: item.ilvl })]),
          ]),
        ),
      ),
    ]);
  }

  function actions(current: RunView): HTMLElement {
    const row = el('div', { class: 'raid__actions' });

    /* У кнопки решения ДВЕ строки: что делаешь и что из этого следует.
       На живых сессиях эвакуацией не воспользовались ни разу, и причина
       оказалась не в балансе: игрок считал, что уходя РИСКУЕТ уже
       выбитым. Правило §7.2 обратное — уносится всё, — но нигде
       не сказано. Механика не изменена, изменено только то, что о ней
       написано. */
    const add = (
      label: string,
      className: string,
      act: () => Promise<void>,
      hint?: string,
    ): void => {
      const button = el('button', { class: className, type: 'button' }, [
        el('span', { class: 'raid__actionLabel' }, [label]),
        ...(hint === undefined ? [] : [el('span', { class: 'raid__actionHint' }, [hint])]),
      ]) as HTMLButtonElement;
      button.addEventListener('click', () => {
        // Кнопка гасится на время запроса: два «в бой» подряд отправили
        // бы вторую команду поверх незавершённой первой. Сервер второй
        // бой всё равно не проведёт, но игрок увидел бы ошибку там,
        // где её нет.
        button.disabled = true;
        void act().catch(fail);
      });
      row.append(button);
    };

    if (current.next !== null) {
      add(
        t('raid.action.fight'),
        'button',
        async () => {
          const result = await api.runFight();
          await showBattle(result);
        },
        // Цена риска называется только когда она есть: с пустой сумкой
        // терять нечего, и подпись про потерю была бы пугалкой впустую.
        current.bag.length === 0
          ? undefined
          : t('raid.action.fightHint', { items: plural(current.bag.length, 'unit.items') }),
      );
    }

    if (current.potionsLeft > 0 && current.hp < current.maxHp) {
      add(
        t('raid.action.potion', { left: current.potionsLeft }),
        'button button--small',
        async () => {
          await api.runPotion();
          await refresh();
          draw();
        },
      );
    }

    if (current.canExtract) {
      // Эвакуация — не «отмена», а решение. Подпись говорит, что именно
      // игрок забирает и что при этом НИЧЕГО не теряет: без второго
      // половина решения принималась вслепую.
      add(
        t('raid.action.extract'),
        'button button--ghost',
        async () => {
          await api.runExtract();
          await refresh();
          draw();
        },
        t('raid.action.extractHint', { items: plural(current.bag.length, 'unit.items') }),
      );
    }

    return row;
  }

  /* ─────────────────────────── показ боя ──────────────────────────── */

  async function showBattle(result: RunFightResponse): Promise<void> {
    clear(host);

    /* Экран боя переиспользует РАСКЛАДКУ арены, а не только её код.
       Сетка `.screen--arena` раздаёт grid-области сцене, органам
       управления, журналу и панели; без неё холст, вынесенный
       из потока абсолютным позиционированием, схлопнулся бы в ноль
       и бой шёл бы на пустом месте. Класс возвращается обратно
       в `draw()`. */
    host.className = 'screen screen--arena';

    const canvas = el('canvas', { class: 'arena__canvas' }) as HTMLCanvasElement;
    const overlay = el('div', { class: 'arena__overlay' });
    const readout = el('p', { class: 'arena__readout' }, [t('arena.loading')]);
    const controls = el('div', { class: 'arena__controls' });
    const journalHost = el('div', { class: 'arena__journal' });

    const done = el('button', { class: 'button', type: 'button' }, [
      t('raid.action.continue'),
    ]) as HTMLButtonElement;

    /* ИТОГ БОЯ НЕ ПОКАЗЫВАЕТСЯ, ПОКА БОЙ НЕ ДОСМОТРЕН.
     
       До этой правки панель наград и кнопка «продолжить» выкладывались
       ВМЕСТЕ с ареной, то есть «Отряд погиб», добыча и кнопка выхода
       стояли над боем с первого кадра. Это не мелочь показа: единственная
       причина смотреть бой — узнать, чем он кончится, — уничтожалась
       одной кнопкой, и на живых сессиях бой пропускали всегда.
     
       Кнопка «сразу итог» остаётся: смотреть пока нечего, две коробки
       бьют друг друга. Она уходит вместе с работой над зрелищностью,
       а не раньше. */
    const outcomeBar = el('div', { class: 'arena__bar' }, [readout]);
    const reveal = (): void => {
      if (!outcomeBar.contains(done)) outcomeBar.append(rewardsBlock(result), done);
    };

    host.append(
      el('div', { class: 'arena__stage' }, [canvas, overlay]),
      controls,
      journalHost,
      // Награды стоят в ПАНЕЛИ, а не отдельной строкой: сетка арены
      // раздаёт области четырём известным детям, и пятый ребёнок
      // попал бы в неявную строку и растянул её за край экрана.
      outcomeBar,
    );

    const mounted = await mountBattle(
      { canvas, overlay, controls, journalHost, readout },
      {
        log: result.log,
        outcome: result.outcome,
        maxHp: result.maxHp,
        enemyLook: result.enemyLook,
        onFinished: reveal,
      },
    );

    /* Страховка на случай, когда показать бой не удалось (нет WebGL,
       не загрузился движок): без неё игрок остался бы на экране
       без единой кнопки. */
    if (mounted === null) reveal();

    done.addEventListener('click', () => {
      mounted?.stop();
      done.disabled = true;
      // Состояние берётся СВЕЖИМ запросом, а не из ответа боя: между
      // боем и нажатием «дальше» игрок мог открыть вкладку и что-то
      // сделать, и показать ему устаревшее было бы хуже, чем лишний
      // запрос.
      void refresh()
        .then(() => draw())
        .catch(fail);
    });
  }

  /** Что дал бой. Числа ИЗ ОТВЕТА: клиент ничего не складывает. */
  function rewardsBlock(result: RunFightResponse): HTMLElement {
    const lost = result.run.state === 'wiped';

    return el('div', { class: lost ? 'raid__rewards raid__rewards--lost' : 'raid__rewards' }, [
      el('span', {}, [t('raid.reward.xp', { xp: result.rewards.xp })]),
      el('span', {}, [t('raid.reward.gold', { gold: result.rewards.gold })]),
      el('span', {}, [t('raid.reward.loot', { count: result.rewards.loot.length })]),
      ...(lost
        ? [
            // Потеря названа прямо: пустой экран после смерти — это
            // ровно то, чего §7.2 велит избегать.
            el('strong', { class: 'raid__wiped' }, [t('raid.wiped')]),
          ]
        : []),
      ...(result.run.state === 'extracted'
        ? [el('strong', { class: 'raid__extracted' }, [t('raid.extracted')])]
        : []),
    ]);
  }

  draw();
}
