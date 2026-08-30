import en from '../../../locales/en.json';
import ru from '../../../locales/ru.json';

/**
 * Инвариант 6: ни одной пользовательской строки в коде UI.
 *
 * Словари импортируются из locales/ на сборке, поэтому опечатка в ключе
 * ловится компилятором: тип Key выводится из ru.json.
 * RU основной — набор ключей берётся из него.
 */
export type Locale = 'ru' | 'en';
export type Key = keyof typeof ru;

const DICTS: Record<Locale, Record<string, string>> = { ru, en };
const STORAGE_KEY = 'extramundum.locale';

function detect(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'ru' || stored === 'en') return stored;
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

let current: Locale = detect();

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  current = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.lang = locale;
}

/**
 * Перевод по ключу. `params` подставляются в плейсхолдеры вида {name}.
 *
 * Ключ, которого нет в словаре, возвращается как есть — так недостающая
 * строка видна в интерфейсе сразу, а не превращается в пустоту.
 */
export function t(key: Key | string, params?: Record<string, string | number>): string {
  const dict = DICTS[current];
  const fallback = DICTS.ru;
  let value = dict[key] ?? fallback[key] ?? key;

  if (params) {
    for (const [name, replacement] of Object.entries(params)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
  }

  return value;
}

/**
 * Число с существительным в нужной форме: «1 предмет», «2 предмета»,
 * «5 предметов».
 *
 * Русские правила склонения не выражаются подстановкой `{count}`
 * в одну строку, а «1 предметов» на кнопке решения — ровно та мелочь,
 * из-за которой интерфейс выглядит машинным. Ключи хранят три формы;
 * в языках с двумя (английский) вторая и третья совпадают, и правило
 * ниже выберет верную само.
 */
export function plural(count: number, key: string): string {
  const mod10 = Math.abs(count) % 10;
  const mod100 = Math.abs(count) % 100;

  const form =
    getLocale() === 'ru'
      ? mod10 === 1 && mod100 !== 11
        ? 'one'
        : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
          ? 'few'
          : 'many'
      : count === 1
        ? 'one'
        : 'many';

  return `${count} ${t(`${key}.${form}`)}`;
}
