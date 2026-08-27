import { describe, expect, it } from 'vitest';
import { Mesh } from 'three';

import { paletteHex } from '../palette.js';
import { createBattleScene } from '../scene.js';

/**
 * Силуэт противника. GDD §7.5, ART-BIBLE §3.
 *
 * «Новый монстр — запись в данных, а не правка кода.» Проверяется это
 * так же, как для рига: берём ДВЕ разные записи и смотрим, что сцена
 * собралась по-разному. Кода при этом никто не трогает.
 *
 * Облик приходит от сервера готовым, потому что `monsters.json`
 * в браузер не попадает: клиенту нужна форма, а не статы, броня
 * и таблица дропа двадцати монстров. Отсюда и разделение проверок:
 * «у каждого монстра есть существующий риг и цвета» проверяет
 * `packages/data`, где лежат обе стороны, а здесь — что сцена
 * присланным ключом действительно пользуется.
 */

const rigIdOf = (enemy?: { rig: string; recolor?: Record<string, string> }): string =>
  createBattleScene(16 / 9, enemy).fighters[1].root.name;

describe('облик противника из данных монстра', () => {
  it('ключ силуэта выбирает риг: разные ключи — разные формы', () => {
    // Две формы, а не одна: тест «риг применился» прошёл бы и на сцене,
    // которая всегда строит одно и то же.
    expect(rigIdOf({ rig: 'beast' })).toBe('beast');
    expect(rigIdOf({ rig: 'brute' })).toBe('brute');
    expect(rigIdOf({ rig: 'beast' })).not.toBe(rigIdOf({ rig: 'brute' }));
  });

  it('без облика противник человекоподобен — как и был до M3b', () => {
    expect(rigIdOf()).toBe('humanoid');
  });

  it('неизвестный ключ не роняет бой, а даёт человекоподобного', () => {
    // Силуэт важен, но не настолько, чтобы из-за него не показать бой:
    // лог уже записан, исход уже применён, и пустой экран здесь был бы
    // хуже неправильной формы.
    expect(rigIdOf({ rig: 'нет-такого-рига' })).toBe('humanoid');
  });

  it('перекраска доходит до мешей противника, а игрока не трогает', () => {
    const built = createBattleScene(16 / 9, { rig: 'gaunt', recolor: { bone: 'blood' } });

    const colors = (index: 0 | 1): number[] => {
      const found: number[] = [];
      built.fighters[index].root.traverse((node) => {
        if (node instanceof Mesh) {
          found.push((node.material as { color: { getHex(): number } }).color.getHex());
        }
      });
      return found;
    };

    // Подмена обязана быть ЖИВОЙ: если в риге нет ни одного узла цвета
    // `bone`, тест «цвет заменился» прошёл бы, ничего не проверив.
    expect(colors(1)).toContain(paletteHex('blood'));
    expect(colors(1)).not.toContain(paletteHex('bone'));

    // Игрок собирается из своей спецификации и перекраску врага
    // не получает: иначе оба бойца красились бы заодно.
    expect(colors(0)).toContain(paletteHex('bone'));
    expect(colors(0)).not.toContain(paletteHex('blood'));
  });

});
