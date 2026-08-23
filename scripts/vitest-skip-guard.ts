import type { Reporter } from 'vitest/node';

/**
 * Страж пропущенных тестов.
 *
 * ПОЧЕМУ ОН ЕСТЬ. Интеграционные тесты пропускаются без `DATABASE_URL`,
 * и это удобно локально — но ровно на этом я и попался в M2b: гонял
 * `pnpm test` без базы, видел «зелено», а в CI лежал красный прогон
 * с тестом, который ждал от `/battle/start` ответа 501. Пропуск был
 * виден в выводе одной строкой среди прочих и ничего не значил.
 *
 * Правило теперь механическое, а не «надо не забыть»:
 *
 *  1. пропущенные ПЕРЕЧИСЛЯЮТСЯ поимённо, а не считаются одним числом
 *     в конце строки — число легко проскочить взглядом, список нет;
 *  2. при `CI=true` любой пропуск ВАЛИТ прогон.
 *
 * Второе — главное. Способа увидеть зелёное на непройденных тестах
 * существовать не должно: тест, который не выполнялся, ничего
 * не доказывает, а выглядит как доказательство.
 *
 * Локально пропуск остаётся пропуском: поднимать Postgres ради правки
 * в подписи кнопки незачем. Разница между «локально» и «в CI» — ровно
 * переменная `CI`, и она же стоит в workflow.
 */

export type Task = {
  readonly type?: string;
  readonly name?: string;
  readonly mode?: string;
  readonly result?: { readonly state?: string };
  readonly tasks?: readonly Task[];
};

/** Пропущенный тест: `mode` равен skip или todo — состояния у него нет. */
export function collectSkipped(task: Task, trail: readonly string[], out: string[]): void {
  const path = task.name === undefined ? trail : [...trail, task.name];

  if (task.type === 'test' && (task.mode === 'skip' || task.mode === 'todo')) {
    out.push(`${path.join(' › ')}${task.mode === 'todo' ? ' (todo)' : ''}`);
    return;
  }

  for (const child of task.tasks ?? []) collectSkipped(child, path, out);
}

export default class SkipGuard implements Reporter {
  onFinished(files: readonly Task[] = []): void {
    const skipped: string[] = [];
    for (const file of files) collectSkipped(file, [], skipped);

    if (skipped.length === 0) return;

    const inCI = process.env['CI'] === 'true';
    const head = inCI ? 'ПРОПУЩЕННЫЕ ТЕСТЫ — В CI ЭТО ОШИБКА' : 'ПРОПУЩЕННЫЕ ТЕСТЫ';

    console.log(`\n${head} (${skipped.length}):`);
    for (const name of skipped) console.log(`  · ${name}`);

    if (!inCI) {
      console.log(
        '\n  Интеграционные тесты пропускаются без DATABASE_URL. Чтобы прогнать их:\n' +
          '    pnpm db:local:up\n' +
          '    DATABASE_URL=postgres://postgres@127.0.0.1:55432/extramundum pnpm test\n',
      );
      return;
    }

    console.log(
      '\n  В CI пропусков быть не должно: тест, который не выполнялся,\n' +
        '  ничего не доказывает, а выглядит как доказательство. Обычная\n' +
        '  причина — не поднялась база; смотри шаг services в workflow.\n',
    );
    process.exitCode = 1;
  }
}
