/**
 * Спрайт векторных силуэтов, вложенный в документ.
 *
 * `<use href="#i-...">` разрешается только внутри ТОГО ЖЕ документа:
 * внешняя ссылка вида `href="/assets/icons.svg#id"` в браузерах
 * поддержана неровно, и полагаться на неё нельзя. Поэтому файл
 * подтягивается один раз и вкладывается в `body` скрытым узлом.
 *
 * ССЫЛКА ЖИВАЯ, и на этом всё держится: `<use>`, нарисованный ДО того,
 * как символ появился в документе, отрисуется сам, когда символ
 * появится. Значит ждать загрузки спрайта перед первым кадром не нужно,
 * и иконки не мигают пустотой при переключении экранов.
 *
 * Если файл не доехал, ничего не ломается: символов нет, `<use>`
 * остаётся пустым, а игра работает. Это то же требование ART-BIBLE §7,
 * что и у квадратов с буквой, только на уровень выше.
 */
const SPRITE_URL = '/assets/icons-placeholder.svg';
const MOUNT_ID = 'extramundum-icon-sprite';

let started = false;

export function mountIconSprite(): void {
  if (started || document.getElementById(MOUNT_ID) !== null) return;
  started = true;

  void fetch(SPRITE_URL)
    .then((response) => (response.ok ? response.text() : null))
    .then((text) => {
      if (text === null) return;
      const holder = document.createElement('div');
      holder.id = MOUNT_ID;
      holder.hidden = true;
      /* Разбор через DOMParser, а не innerHTML: содержимое своё, но
         правило проекта — не подставлять разметку строкой, и заводить
         для спрайта исключение значило бы завести привычку.

         РЕЖИМ `text/html`, А НЕ `image/svg+xml`, И ЭТО НЕ ПРИДИРКА.
         XML запрещает `--` внутри комментария, а шапка набора
         документирует имена переменных палитры — `--pal-bone` и прочие.
         Строгий разбор на этом падает целиком: вместо корня `svg`
         возвращается `parsererror`, символов ноль, иконки пустые.
         Поймано живым запуском — тесты на манифест этого не видят,
         они читают файл текстом.
         Разбор HTML снисходителен и раскладывает вложенный svg
         в правильное пространство имён. */
      const parsed = new DOMParser().parseFromString(text, 'text/html');
      const root = parsed.querySelector('svg');
      if (root === null) return;
      holder.append(document.importNode(root, true));
      document.body.append(holder);
    })
    .catch(() => {
      /* Молча: отсутствие спрайта — не ошибка, а состояние «ассетов
         ещё нет». Падать из-за него значило бы нарушить §7. */
    });
}
