import type { RollBreakdown } from '@extramundum/shared';
import { describe, expect, it } from 'vitest';

import { buildJournal, type JournalEntry } from '../journal.ts';

import { log } from './fixture.ts';

/**
 * Модель журнала. GDD §3.2, §10.
 *
 * Журнал существует затем, чтобы игрок понял, ПОЧЕМУ проиграл.
 * Значит проверять надо два свойства: что сигнал не утоплен (тики
 * свёрнуты) и что числа объясняют урон (множители перемножаются в него).
 */

const rows = buildJournal(log);
const strikes = rows.filter(
  (row): row is Extract<JournalEntry, { kind: 'strike' }> => row.kind === 'strike',
);
const effects = rows.filter(
  (row): row is Extract<JournalEntry, { kind: 'effects' }> => row.kind === 'effects',
);

/** Произведение шагов пайплайна — в том же порядке, что в движке. */
function product(roll: RollBreakdown): number {
  return (
    roll.weaponRoll *
    roll.ilvlScale *
    roll.atkMultiplier *
    roll.matchupMultiplier *
    (1 - roll.mitigation) *
    roll.critMultiplier *
    (1 - roll.blockReduction)
  );
}

describe('разбор броска', () => {
  it('множители перемножаются В ПОКАЗАННЫЙ УРОН', () => {
    expect(strikes.length).toBeGreaterThan(10);
    for (const strike of strikes) {
      expect(Math.max(0, Math.round(product(strike.roll)))).toBe(strike.roll.final);
    }
  });

  it('крит и блок в выборке РЕАЛЬНО встречались', () => {
    // Без этого проверка выше проходит на логе, где critMultiplier
    // и blockReduction всегда равны единице и нулю: перемножение
    // «в лоб» сошлось бы, а два множителя из семи остались бы
    // не проверенными ни разу.
    const crits = strikes.filter((strike) => strike.roll.critMultiplier !== 1);
    const blocks = strikes.filter((strike) => strike.roll.blockReduction > 0);
    expect(crits.length).toBeGreaterThan(0);
    expect(blocks.length).toBeGreaterThan(0);

    // И митигация должна быть НЕ НУЛЕВОЙ И РАЗНОЙ: у бойцов разная
    // броня, и одинаковая митигация означала бы, что шаг не работает.
    const mitigations = new Set(strikes.map((strike) => strike.roll.mitigation.toFixed(4)));
    expect(mitigations.size).toBeGreaterThan(1);
    for (const strike of strikes) expect(strike.roll.mitigation).toBeGreaterThan(0);
  });

  it('блок в строке удара — тот же, что в событии блока', () => {
    const blocked = strikes.filter((strike) => strike.blocked !== null);
    expect(blocked.length).toBeGreaterThan(0);
    // Блок пишется в лог отдельным событием, и все они обязаны найтись
    // в строках ударов — иначе часть блоков журнал бы потерял.
    const blockEvents = log.events.filter((event) => event.t === 'block');
    expect(blocked.length).toBe(blockEvents.length);
  });

  it('удар находит свой урон даже через события между ними', () => {
    // Между `attack` и `damage` встают записи поглощения щитом.
    // Правило «урон — следующее событие» сломалось бы молча: удар
    // показался бы без числа.
    const withDamage = strikes.filter((strike) => strike.damage !== null);
    expect(withDamage.length).toBe(strikes.length);

    const gaps = strikes.filter((strike) => {
      const next = log.events[strike.index + 1];
      return next !== undefined && next.t !== 'damage';
    });
    expect(gaps.length, 'между ударом и уроном нигде нет событий').toBeGreaterThan(0);
  });
});

describe('свёртка тиков', () => {
  it('пачка подряд идущих тиков становится одной строкой', () => {
    const tickEvents = log.events.filter((event) => event.t === 'status_tick');
    expect(tickEvents.length).toBeGreaterThan(5);

    // Свёрнутых строк должно быть МЕНЬШЕ, чем тиков: иначе свёртки нет.
    expect(effects.length).toBeGreaterThan(0);
    expect(effects.length).toBeLessThan(tickEvents.length);

    // Хотя бы одна строка обязана свернуть больше одного тика — иначе
    // «свёртка» проверена на пачках из одного элемента, то есть никак.
    expect(Math.max(...effects.map((row) => row.entries.length))).toBeGreaterThan(1);
  });

  it('ни один тик не потерян', () => {
    const tickEvents = log.events.filter((event) => event.t === 'status_tick');
    const collapsed = effects.reduce((sum, row) => sum + row.entries.length, 0);
    expect(collapsed).toBe(tickEvents.length);
  });

  it('сумма строки равна сумме величин её тиков', () => {
    for (const row of effects) {
      const sum = row.entries.reduce((acc, entry) => acc + (entry.amount ?? 0), 0);
      expect(row.total).toBe(sum);
    }
    // И хотя бы одна сумма отлична от нуля: иначе «сумма совпала»
    // означало бы «оба нуля».
    expect(effects.some((row) => row.total > 0)).toBe(true);
  });
});

describe('отражённый урон', () => {
  it('получает свою строку, а урон удара — нет', () => {
    // `thorns` бьёт по АТАКУЮЩЕМУ. Слить это с уроном удара значило бы
    // показать игроку потерю HP без причины.
    const reflected = rows.filter((row) => row.kind === 'event' && row.event.t === 'damage');
    expect(reflected.length).toBeGreaterThan(0);

    const damageEvents = log.events.filter((event) => event.t === 'damage');
    const attached = strikes.filter((strike) => strike.damage !== null).length;
    // Каждое событие урона попало в журнал ровно один раз: либо в строку
    // удара, либо в свою собственную.
    expect(attached + reflected.length).toBe(damageEvents.length);
  });
});

describe('порядок журнала', () => {
  it('строки идут в порядке лога и покрывают его целиком', () => {
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]?.index).toBeGreaterThan(rows[i - 1]?.index ?? -1);
    }
    expect(rows[0]?.index).toBe(0);
    expect(rows.length).toBeLessThan(log.events.length);
  });
});
