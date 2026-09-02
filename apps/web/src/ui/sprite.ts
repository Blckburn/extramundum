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

         РЕЖИМ СТРОГИЙ, `image/svg+xml`. Первая версия набора была
         невалидным XML: её шапка документировала имена переменных
         палитры, а XML запрещает двойной дефис внутри комментария.
         Строгий разбор падал целиком — вместо корня `svg` возвращался
         `parsererror`, символов ноль, иконки пустые. В наборе v2 это
         исправлено, и разбор вернулся к строгому: он ловит битый файл
         сразу, а снисходительный молча отдаёт половину.

         ЯВНАЯ ПРОВЕРКА `parsererror` НУЖНА, потому что DOMParser
         НЕ БРОСАЕТ исключение: при ошибке он возвращает документ,
         в котором корень — описание ошибки. Без проверки битый набор
         вложился бы в страницу пустым узлом, и иконки исчезли бы
         молча — ровно то, на чём мы уже один раз стояли. */
      const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
      if (parsed.querySelector('parsererror') !== null) return;
      const root = parsed.documentElement;
      if (root.nodeName.toLowerCase() !== 'svg') return;
      holder.append(document.importNode(root, true));
      document.body.append(holder);
    })
    .catch(() => {
      /* Молча: отсутствие спрайта — не ошибка, а состояние «ассетов
         ещё нет». Падать из-за него значило бы нарушить §7. */
    });
}
