import type { RunFightResponse, RunSummary, RunView, ZoneCard } from '@extramundum/shared';

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
  /**
   * Прямой переход в снаряжение с экрана итогов.
   *
   * На живых сессиях после рейда одеваться было неудобно: приходилось
   * возвращаться в деревню и оттуда идти в инвентарь, прокручивая
   * экран до кнопки внизу (PLAYTEST 2026-09-04). Итог рейда — ровно
   * тот момент, когда игрок хочет надеть добытое, и вести его туда
   * через два экрана значит мешать ему в единственном месте, где
   * он точно знает, чего хочет.
   */
  readonly onGear: () => void;
};

export function renderRaid(root: HTMLElement, onBack: () => void, onGear: () => void): void {
  void render({ root, onBack, onGear });
}

async function render(surface: Surface): Promise<void> {
  clear(surface.root);
  const host = el('main', { class: 'screen screen--raid' });
  surface.root.append(host);

  const back = el('button', { class: 'button button--ghost', type: 'button' }, [t('action.back')]);
  back.addEventListener('click', surface.onBack);

  let zones: readonly ZoneCard[] = [];
  let run: RunView | null = null;
  /* Итог показывается ВМЕСТО выбора зоны и ровно один раз: забега
     уже нет, а уходить с экрана, ничего не сказав, — это и есть
     та самая «награда за босса не показана». */
  let summary: RunSummary | null = null;

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
    if (summary !== null) {
      host.append(summaryPanel(summary));
      return;
    }
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
      // Запертая зона показывает ЗАМОК И ПРИЧИНУ, а не пустое место:
      // «сюда нельзя» без «а когда можно» — это тупик, а не правило.
      zone.unlocked ? segmentPicker(zone) : el('p', { class: 'zone__locked' }, [t('zone.locked')]),
    ]);
    return card;
  }

  /**
   * Выбор участка, затем сложности. GDD §7.4 в редакции после тупика.
   *
   * ДВЕ ОСИ, И КАЖДАЯ ОТВЕЧАЕТ ЗА СВОЁ: участок задаёт уровень добычи,
   * сложность — её редкость. Сложить их в один список из двенадцати
   * кнопок значило бы спрятать это разделение ровно там, где игрок
   * принимает решение.
   *
   * По умолчанию выбран САМЫЙ ГЛУБОКИЙ открытый участок: он и есть
   * то место, ради которого игрок сюда пришёл. Нижние остаются
   * доступны — в этом вся правка.
   */
  function segmentPicker(zone: ZoneCard): HTMLElement {
    const open = zone.segments.filter((segment) => segment.unlocked);
    let chosen = open[open.length - 1]?.index ?? 0;

    const tiers = el('div', { class: 'zone__difficulties' }, []);
    const row = el('div', { class: 'zone__segments' }, []);

    const paint = (): void => {
      clear(row);
      row.append(
        ...zone.segments.map((segment) => {
          const button = el('button', {
            class:
              'button button--small zone__segment' +
              (segment.index === chosen ? ' zone__segment--active' : '') +
              (segment.cleared ? ' zone__segment--cleared' : ''),
            type: 'button',
            /* Выбранное отличается не только цветом (бриф, п. 2):
               `aria-pressed` даёт и рамку через CSS, и голос экранному
               диктору. */
            'aria-pressed': segment.index === chosen ? 'true' : 'false',
          }) as HTMLButtonElement;
          /* Уровни И МНОЖИТЕЛЬ: это две половины ответа на «насколько
             тут трудно». Уровень говорит, как глубоко, множитель —
             насколько тяжело само место. Показать один без другого
             значило бы дать половину основания для выбора. */
          button.textContent =
            t('raid.segment', {
              index: segment.index + 1,
              min: segment.levels[0],
              max: segment.levels[1],
            }) + ` · ×${segment.power.toFixed(2)}`;
          if (!segment.unlocked) {
            button.disabled = true;
            // Отключённое ОБЪЯСНЯЕТ причину (бриф, п. 2).
            button.title = t('raid.segmentLocked');
          }
          button.addEventListener('click', () => {
            chosen = segment.index;
            paint();
          });
          return button;
        }),
      );

      clear(tiers);
      tiers.append(...difficultyButtons(zone, chosen));
    };

    paint();
    return el('div', { class: 'zone__pick' }, [row, tiers]);
  }

  function difficultyButtons(zone: ZoneCard, segment: number): HTMLElement[] {
    return (['normal', 'dangerous', 'nightmare'] as const).map((difficulty) => {
      const rules = zone.difficulties[difficulty];
      const button = el('button', { class: 'button button--small', type: 'button' }, [
        /* Сила тира названа числом. Тир НЕ ДВИГАЕТ УРОВЕНЬ врага —
           уровень целиком приходит из участка, — поэтому без множителя
           «Опасная» отличалась бы от «Обычной» только словом. */
        `${t(`difficulty.${difficulty}`)}` +
          (rules.power === 1
            ? ''
            : ` · ${t('raid.enemyPower', { value: rules.power.toFixed(2) })}`) +
          ` · ${t('raid.lootMultiplier', { value: rules.lootMultiplier.toFixed(2) })}`,
      ]) as HTMLButtonElement;

      button.addEventListener('click', () => {
        button.disabled = true;
        void api
          .startRun({ zone: zone.id, segment, difficulty })
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
        `${t('raid.runSegment', {
          index: current.segment + 1,
          min: current.segmentLevels[0],
          max: current.segmentLevels[1],
        })} · ${t(`difficulty.${current.difficulty}`)} · ${t('raid.progress', {
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
    const row = el('div', { class: 'raid__actions screen__actions' });

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
          const left = await api.runExtract();
          await refresh();
          // Уход — тоже конец забега, и итог у него тот же.
          summary = left.summary;
          draw();
        },
        t('raid.action.extractHint', { items: plural(current.bag.length, 'unit.items') }),
      );
    }

    return row;
  }

  /* ────────────────────────── итог рейда ──────────────────────────── */

  /**
   * ЧЕМ КОНЧИЛСЯ ЗАБЕГ. GDD §7.2.
   *
   * До этой правки не показывалось ничем: сумка молча уезжала
   * в инвентарь, экран возвращался к выбору зоны, и добыча за пятый
   * бой — тот самый, ради которого игрок не ушёл, — исчезала
   * незамеченной (PLAYTEST 2026-09-04).
   *
   * Числа приходят от СЕРВЕРА суммой по журналу боёв. Клиент их
   * не складывает: игрок мог закрыть вкладку посреди забега, и складывать
   * ему было бы нечего.
   */
  function summaryPanel(done: RunSummary): HTMLElement {
    const lost = done.state === 'wiped';

    return el('section', { class: 'raid__summary' }, [
      el('h1', { class: 'screen__title' }, [
        lost ? t('summary.title.wiped') : t('summary.title.done'),
      ]),
      el('p', { class: 'raid__lead' }, [
        `${t(`zone.${done.zone}`)} · ${t('raid.runSegment', {
          index: done.segment + 1,
          min: done.segmentLevels[0],
          max: done.segmentLevels[1],
        })} · ${t(`difficulty.${done.difficulty}`)}`,
      ]),

      el(
        'p',
        { class: lost ? 'raid__summaryState raid__summaryState--lost' : 'raid__summaryState' },
        [t('summary.cleared', { done: done.fightsCleared, total: 5 })],
      ),

      /* УЧАСТОК ЗАСЧИТЫВАЕТСЯ ЗА БОССА, и сказать об этом надо здесь:
         игрок только что узнал, открылось ли ему следующее место,
         и узнать это из молчания нельзя. */
      done.bossKilled
        ? el('p', { class: 'raid__summaryUnlock' }, [t('summary.unlocked')])
        : el('p', { class: 'raid__summaryUnlock raid__summaryUnlock--no' }, [
            t('summary.notUnlocked'),
          ]),

      el('div', { class: 'raid__summaryTotals' }, [
        el('span', {}, [t('raid.reward.xp', { xp: done.xp })]),
        el('span', {}, [t('raid.reward.gold', { gold: done.gold })]),
      ]),

      /* ДОБЫЧА ЗА ЗАБЕГ ЦЕЛИКОМ, включая пятый бой. Пустой список
         при смерти — это не «нет данных», а сам итог, и он называется
         словами. */
      done.loot.length === 0
        ? el('p', { class: 'raid__bag raid__bag--empty' }, [
            lost ? t('summary.lootLost') : t('summary.lootNone'),
          ])
        : el('div', { class: 'raid__bag' }, [
            el('h2', { class: 'raid__subtitle' }, [t('summary.loot', { count: done.loot.length })]),
            el(
              'ul',
              { class: 'raid__bagList' },
              done.loot.map((item) =>
                el('li', { class: `raid__bagItem raid__bagItem--${item.rarity}` }, [
                  renderIcon(item.baseKey, 128, t(`item.${item.baseKey}`)),
                  el('span', {}, [t(`item.${item.baseKey}`)]),
                  el('span', { class: 'raid__bagIlvl' }, [
                    t('item.level.short', { ilvl: item.ilvl }),
                  ]),
                ]),
              ),
            ),
          ]),

      /* ГЛАВНОЕ ДЕЙСТВИЕ — В ЛИПКОЙ ПОЛОСЕ ВНИЗУ (UI-BRIEF §1), и оно
         здесь одно: надеть добытое. Возврат в деревню стоит рядом
         вторым, а не единственным, — иначе за снаряжением пришлось бы
         идти через два экрана ровно в тот момент, когда игрок точно
         знает, чего хочет. */
      el('div', { class: 'raid__actions screen__actions' }, [
        summaryButton(t('summary.action.gear'), 'button', surface.onGear),
        summaryButton(t('summary.action.again'), 'button button--ghost', () => {
          summary = null;
          draw();
        }),
      ]),
    ]);
  }

  function summaryButton(label: string, className: string, act: () => void): HTMLElement {
    const button = el('button', { class: className, type: 'button' }, [label]) as HTMLButtonElement;
    // Отклик рисуется сразу, не дожидаясь перерисовки (UI-BRIEF §2).
    button.addEventListener('click', () => {
      button.disabled = true;
      act();
    });
    return button;
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
      /* ИТОГ ПОКАЗЫВАЕТСЯ ПОСЛЕ ТОГО, КАК БОЙ ДОСМОТРЕН, и это то же
         правило, что у панели наград: сервер прислал его вместе
         с боем — он нужен для показа, — но выложить его раньше значило
         бы объявить исход забега над ещё идущим боем. */
      const finished = result.summary;
      void refresh()
        .then(() => {
          summary = finished;
          draw();
        })
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
