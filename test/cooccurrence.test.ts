import { test, expect } from 'bun:test';
import { Cooccurrence } from '../src/cooccurrence.ts';
import { unlinkSync } from 'node:fs';

const tmpDb = () => `/tmp/ragana-cooc-${Math.random().toString(36).slice(2)}.sqlite`;

/** Корпус, где связи заданы намеренно. */
function fill(c: Cooccurrence): void {
  // «ипотека» устойчиво соседствует со «ставка» и «погашение»
  for (let i = 0; i < 5; i++) {
    c.add('Ипотека оформляется по ставке банка с досрочным погашением');
  }
  for (let i = 0; i < 4; i++) {
    c.add('Ставка по ипотеке фиксируется договором погашения');
  }
  // «гарантия» живёт в своём контексте
  for (let i = 0; i < 4; i++) {
    c.add('Гарантия распространяется на ремонт оборудования поставщиком');
  }
  c.flush();
}

test('словарь наполняется и считает термины', () => {
  const f = tmpDb();
  const c = new Cooccurrence(f);
  fill(c);
  const s = c.stats();
  expect(s.terms).toBeGreaterThan(5);
  expect(s.pairs).toBeGreaterThan(10);
  c.close(); unlinkSync(f);
});

test('🟢 находит связанные термины из корпуса', () => {
  const f = tmpDb();
  const c = new Cooccurrence(f);
  fill(c);
  // limit=10: «ставка» и «погашение» встречаются с «ипотекой» в каждом
  // фрагменте, но рядом с ней стоят и другие слова из тех же
  // предложений, поэтому в пятёрку они могут не попасть. Проверяем
  // ПРИСУТСТВИЕ связи, а не её позицию — позиция зависит от корпуса.
  const rel = c.related('ипотека', 10).map((r) => r.term);
  expect(rel.some((t) => t.startsWith('ставк'))).toBe(true);
  expect(rel.some((t) => t.startsWith('погаш'))).toBe(true);
  c.close(); unlinkSync(f);
});

test('🔴 НЕ связывает термины из разных контекстов', () => {
  // Без этого контроля словарь, возвращающий всё подряд, выглядел бы
  // работающим: «ипотека -> гарантия» было бы ложной связью.
  const f = tmpDb();
  const c = new Cooccurrence(f);
  fill(c);
  const rel = c.related('ипотека', 10).map((r) => r.term);
  expect(rel.some((t) => t.startsWith('гарант'))).toBe(false);
  expect(rel.some((t) => t.startsWith('оборудован'))).toBe(false);
  c.close(); unlinkSync(f);
});

test('редкий термин не даёт связей (мало статистики)', () => {
  const f = tmpDb();
  const c = new Cooccurrence(f);
  c.add('Уникальное словосочетание встречается однажды');
  c.flush();
  // Один-два раза — связи были бы случайными
  expect(c.related('уникальное')).toEqual([]);
  c.close(); unlinkSync(f);
});

test('неизвестный термин — пустой результат', () => {
  const f = tmpDb();
  const c = new Cooccurrence(f);
  fill(c);
  expect(c.related('квазимодо')).toEqual([]);
  expect(c.expand('квазимодо кракозябра')).toEqual([]);
  c.close(); unlinkSync(f);
});

test('expand не дублирует уже присутствующие слова', () => {
  const f = tmpDb();
  const c = new Cooccurrence(f);
  fill(c);
  const added = c.expand('ипотека ставка');
  expect(added.some((t) => t.startsWith('ставк'))).toBe(false);
  c.close(); unlinkSync(f);
});

test('expand соблюдает предел', () => {
  const f = tmpDb();
  const c = new Cooccurrence(f);
  fill(c);
  expect(c.expand('ипотека ставка погашение', 2, 3).length).toBeLessThanOrEqual(3);
  c.close(); unlinkSync(f);
});

test('короткие слова и стоп-слова игнорируются', () => {
  const f = tmpDb();
  const c = new Cooccurrence(f);
  for (let i = 0; i < 5; i++) c.add('и в на с по не а о от за для при');
  c.flush();
  // Из одних стоп-слов пар быть не должно
  expect(c.stats().pairs).toBe(0);
  c.close(); unlinkSync(f);
});

test('clear очищает накопленное', () => {
  const f = tmpDb();
  const c = new Cooccurrence(f);
  fill(c);
  expect(c.stats().terms).toBeGreaterThan(0);
  c.clear();
  expect(c.stats()).toEqual({ terms: 0, pairs: 0 });
  c.close(); unlinkSync(f);
});

test('данные переживают закрытие', () => {
  const f = tmpDb();
  const a = new Cooccurrence(f);
  fill(a);
  const before = a.stats();
  a.close();

  const b = new Cooccurrence(f);
  expect(b.stats()).toEqual(before);
  expect(b.related('ипотека').length).toBeGreaterThan(0);
  b.close(); unlinkSync(f);
});

test('пустой и односложный текст не ломают', () => {
  const f = tmpDb();
  const c = new Cooccurrence(f);
  c.add('');
  c.add('одно');
  c.flush();
  expect(c.stats().pairs).toBe(0);
  c.close(); unlinkSync(f);
});
