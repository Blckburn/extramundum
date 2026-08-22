import { afterEach, describe, expect, it, vi } from 'vitest';

import SkipGuard, { collectSkipped, type Task } from '../vitest-skip-guard.ts';

/**
 * Страж пропущенных тестов — сам механика, значит и у него есть тест
 * (инвариант 4). Проверяется главное его свойство: при CI=true пропуск
 * ВАЛИТ прогон, а без CI — нет.
 */

const test_ = (name: string, mode: string): Task => ({ type: 'test', name, mode });

const tree = (): Task => ({
  type: 'suite',
  name: 'file.test.ts',
  mode: 'run',
  tasks: [
    {
      type: 'suite',
      name: 'группа',
      mode: 'run',
      tasks: [test_('идёт', 'run'), test_('пропущен', 'skip'), test_('отложен', 'todo')],
    },
  ],
});

/** Прогон стража на дереве. Возвращает вывод и код выхода после него. */
function run(files: Task[], ci: string | undefined) {
  const before = process.exitCode;
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.join(' '));
  });

  const prevCI = process.env['CI'];
  if (ci === undefined) delete process.env['CI'];
  else process.env['CI'] = ci;
  process.exitCode = undefined;

  try {
    new SkipGuard().onFinished(files);
    return { output: lines.join('\n'), exitCode: process.exitCode };
  } finally {
    log.mockRestore();
    if (prevCI === undefined) delete process.env['CI'];
    else process.env['CI'] = prevCI;
    // Код выхода восстанавливается: иначе тест уронил бы собственный прогон.
    process.exitCode = before;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('сбор пропущенных', () => {
  it('находит skip и todo на любой глубине, а не только у корня', () => {
    const out: string[] = [];
    collectSkipped(tree(), [], out);

    expect(out).toEqual([
      'file.test.ts › группа › пропущен',
      'file.test.ts › группа › отложен (todo)',
    ]);
  });

  it('выполненные тесты не считает пропущенными', () => {
    const out: string[] = [];
    collectSkipped(
      { type: 'suite', name: 'f', mode: 'run', tasks: [test_('идёт', 'run')] },
      [],
      out,
    );
    expect(out).toEqual([]);
  });
});

describe('поведение стража', () => {
  it('при CI=true пропуск ВАЛИТ прогон', () => {
    const { output, exitCode } = run([tree()], 'true');

    expect(exitCode).toBe(1);
    expect(output).toContain('В CI ЭТО ОШИБКА');
    // Пропущенные перечислены поимённо: число в конце строки легко
    // проскочить взглядом, список — нет.
    expect(output).toContain('группа › пропущен');
  });

  it('без CI пропуск НЕ валит прогон, но виден', () => {
    const { output, exitCode } = run([tree()], undefined);

    expect(exitCode).toBeUndefined();
    expect(output).toContain('ПРОПУЩЕННЫЕ ТЕСТЫ');
    expect(output).toContain('DATABASE_URL');
  });

  it('без пропусков молчит и ничего не роняет', () => {
    const clean: Task = {
      type: 'suite',
      name: 'f',
      mode: 'run',
      tasks: [test_('идёт', 'run')],
    };

    for (const ci of ['true', undefined]) {
      const { output, exitCode } = run([clean], ci);
      expect(output, `CI=${String(ci)}`).toBe('');
      expect(exitCode, `CI=${String(ci)}`).toBeUndefined();
    }
  });

  it('CI=1 и CI=yes — это НЕ CI=true', () => {
    // Значение сверяется точно, а не «похоже на правду»: в workflow
    // стоит именно 'true', и расширять набор значений здесь значило бы
    // однажды уронить чей-то локальный прогон из-за постороннего CI=1.
    expect(run([tree()], '1').exitCode).toBeUndefined();
  });
});
