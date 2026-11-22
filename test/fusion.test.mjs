import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rrf, expandQuery, splitQuestions, asQuery, asPassage } from '../core/fusion.mjs';
import { stem } from '../core/lexical.mjs';

/** @param {Array<[string, number]>} rows @returns {import('../types/index.js').Hit[]} */
const hits = (...rows) => rows.map(([id, score], i) => ({ index: i, id, score }));

test('rrf пустых списков -> пусто', () => {
  assert.deepEqual(rrf([]), []);
  assert.deepEqual(rrf([[], []]), []);
});

test('rrf одного списка сохраняет порядок', () => {
  const r = rrf([hits(['a', 9], ['b', 5], ['c', 1])]);
  assert.deepEqual(r.map((x) => x.id), ['a', 'b', 'c']);
});

test('🟢 согласие двух методов перевешивает первое место одного', () => {
  // 'b' второй в обоих списках, 'a' первый только в одном.
  // Это и есть смысл RRF: согласие независимых методов — сильный сигнал.
  const bm = hits(['a', 50], ['b', 1]);
  const vec = hits(['c', 0.9], ['b', 0.89]);
  const r = rrf([bm, vec]);
  assert.equal(r[0]?.id, 'b', 'найденный обоими должен быть первым');
});

test('🔴 rrf использует РАНГ, а не оценку (разные шкалы)', () => {
  // BM25 даёт 50, косинус 0.9 — прямое сложение отдало бы победу BM25
  // просто из-за шкалы. Проверяем, что величина оценки не влияет.
  const big = hits(['x', 1000], ['y', 999]);
  const small = hits(['y', 0.002], ['x', 0.001]);
  const a = rrf([big, small]);

  const bigger = hits(['x', 10_000_000], ['y', 1]);
  const b = rrf([bigger, small]);
  assert.deepEqual(a.map((h) => h.id), b.map((h) => h.id),
    'десятикратное изменение оценок не должно менять порядок');
});

test('ranks показывают позицию в каждом списке, -1 если не найден', () => {
  const r = rrf([hits(['a', 1], ['b', 1]), hits(['b', 1])]);
  const b = r.find((x) => x.id === 'b');
  const a = r.find((x) => x.id === 'a');
  assert.deepEqual(b?.ranks, [2, 1]);
  assert.deepEqual(a?.ranks, [1, -1], 'отсутствие в списке помечено -1');
});

test('веса смещают результат в сторону нужного метода', () => {
  // ВНИМАНИЕ: документ, найденный ОБОИМИ методами, остаётся наверху даже
  // при перекосе весов — и это правильно, согласие важнее. Поэтому вес
  // проверяется на документах, которые нашёл только один метод.
  const bm = hits(['lex', 1]);
  const vec = hits(['sem', 1]);

  const equal = rrf([bm, vec]);
  assert.equal(equal[0]?.score, equal[1]?.score, 'при равных весах — ничья');

  const lexHeavy = rrf([bm, vec], { weights: [10, 1] });
  assert.equal(lexHeavy[0]?.id, 'lex', 'с весом 10 лексический выходит вперёд');

  const vecHeavy = rrf([bm, vec], { weights: [1, 10] });
  assert.equal(vecHeavy[0]?.id, 'sem', 'и наоборот — вес реально влияет');
});

test('согласие ПЕРЕВЕШИВАЕТ перекос весов (документирует поведение)', () => {
  const bm = hits(['lex', 1], ['both', 1]);
  const vec = hits(['sem', 1], ['both', 1]);
  const r = rrf([bm, vec], { weights: [10, 1] });
  assert.equal(r[0]?.id, 'both', 'найденный обоими остаётся первым');
});

test('limit ограничивает выдачу', () => {
  const many = hits(...Array.from({ length: 30 }, (_, i) => /** @type {[string, number]} */ ([`d${i}`, 30 - i])));
  assert.equal(rrf([many], { limit: 5 }).length, 5);
});

test('rrf отсортирован по убыванию', () => {
  const r = rrf([hits(['a', 1], ['b', 1], ['c', 1]), hits(['c', 1], ['a', 1])]);
  for (let i = 1; i < r.length; i++) {
    assert.ok((r[i - 1]?.score ?? 0) >= (r[i]?.score ?? 0));
  }
});

test('🔴 ПОЗИТИВНЫЙ КОНТРОЛЬ: расширение запроса РЕАЛЬНО срабатывает', () => {
  // Именно этот контроль поймал вчерашний провал: 17 правил молча не
  // срабатывали из-за \b, и замер показывал 0/N изменений.
  const queries = [
    'сколько я плачу при аварии',
    'что будет если выпил',
    'когда дадут отпуск',
    'как позвонить в службу',
  ];
  let changed = 0;
  for (const q of queries) {
    const r = expandQuery(q, stem);
    if (r.added.length > 0) changed++;
  }
  assert.equal(changed, queries.length, `сработало только ${changed}/${queries.length}`);
});

test('🔴 сверка словаря идёт ПО ОСНОВАМ, не по словоформам', () => {
  // вторая вчерашняя ошибка: словарь из стемм, а проверялось сырое слово
  const r = expandQuery('была авария вчера', stem);
  assert.ok(r.added.length > 0, 'словоформа "авария" должна найтись');
  const r2 = expandQuery('после аварии', stem);
  assert.ok(r2.added.length > 0, 'и косвенный падеж "аварии" тоже');
});

test('расширение добавляет осмысленные термины', () => {
  const r = expandQuery('сколько платить при аварии', stem);
  assert.ok(r.query.includes('франшиза') || r.query.includes('ущерб'),
    `ожидались термины домена, получено: ${r.query}`);
  assert.ok(r.query.startsWith('сколько платить при аварии'), 'исходный запрос сохранён');
});

test('расширение не дублирует уже присутствующее слово', () => {
  const r = expandQuery('какая франшиза', stem);
  const words = r.query.split(/\s+/);
  const count = words.filter((w) => stem(w.toLowerCase()) === stem('франшиза')).length;
  assert.equal(count, 1, 'термин не продублирован');
});

test('запрос без триггеров не меняется', () => {
  const r = expandQuery('квазимодо кракозябра', stem);
  assert.deepEqual(r.added, []);
  assert.equal(r.query, 'квазимодо кракозябра');
});

test('пустой запрос не ломает расширение', () => {
  const r = expandQuery('', stem);
  assert.deepEqual(r.added, []);
});

test('🟢 составной вопрос делится по союзу', () => {
  const parts = splitQuestions('какая франшиза и когда платить');
  assert.equal(parts.length, 2, `получено: ${JSON.stringify(parts)}`);
  assert.ok(parts[0]?.includes('франшиза'));
  assert.ok(parts[1]?.includes('когда'));
});

test('простой вопрос НЕ делится (контроль)', () => {
  // без этого теста сплиттер, режущий по каждому "и", прошёл бы как рабочий
  assert.deepEqual(splitQuestions('какая франшиза'), ['какая франшиза']);
  assert.deepEqual(splitQuestions('договор и приложение к нему'),
    ['договор и приложение к нему'], '"и" между существительными не делит');
});

test('префиксы E5 проставляются', () => {
  assert.equal(asQuery('вопрос'), 'query: вопрос');
  assert.equal(asPassage('текст'), 'passage: текст');
});
