import {
  animationSpecSchema,
  paletteSchema,
  rigSpecSchema,
  type AnimationSpec,
  type Palette,
  type RigSpec,
} from '@extramundum/shared';

import arenaJson from './rigs/arena.json' with { type: 'json' };
import humanoidJson from './rigs/humanoid.json' with { type: 'json' };
import mundaJson from './rigs/munda.json' with { type: 'json' };
import animationsJson from './animations.json' with { type: 'json' };
import paletteJson from './palette.json' with { type: 'json' };

/**
 * Палитра и риги. ART-BIBLE §3, GDD §3.4.
 *
 * Разбираются схемой ЗДЕСЬ, один раз, а не в рендере: клиент получает
 * уже проверенные данные и не решает, что делать с кривым цветом.
 * Ошибка в json падает на сборке, а не в браузере у игрока.
 */
export const palette: Palette = paletteSchema.parse(paletteJson);

/**
 * Анимации воспроизведения. GDD §3.2, §10.
 *
 * Разбираются схемой здесь же, один раз: кривая запись падает на сборке,
 * а не превращается в бой без единой вспышки у игрока.
 */
export const animations: AnimationSpec = animationSpecSchema.parse(animationsJson);

export const RIGS = {
  humanoid: rigSpecSchema.parse(humanoidJson),
  arena: rigSpecSchema.parse(arenaJson),
  munda: rigSpecSchema.parse(mundaJson),
} as const satisfies Record<string, RigSpec>;

export type RigId = keyof typeof RIGS;

/**
 * Цвет по ключу палитры.
 *
 * Неизвестный ключ — ошибка данных, а не тихий фиолетовый. Спецификация
 * рига, ссылающаяся на несуществующий цвет, обязана падать на сборке:
 * молча подставленный цвет — это ассет, про который забыли, и заметят
 * его через месяц на скриншоте.
 */
export function paletteColor(key: string): string {
  const entry = palette[key];
  if (entry === undefined) throw new Error(`нет цвета «${key}» в palette.json`);
  return entry.hex;
}
