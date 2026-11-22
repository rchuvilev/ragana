import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  link, dropped, mergeAdjacent, rehydrate,
  validateStructure, renderStructure, sourceLabel,
} from '../core/cite.mjs';

const SRC = 'Франшиза составляет 300 евро. Выплата производится в течение 10 дней. Сервис работает круглосуточно.';

/** @returns {import('../types/index.js').Chunk} */
const ch = (id, path, start, end, ord = 0, page = undefined) => {
  /** @type {any} */
  const c = { id, path, text: SRC.slice(start, end), start, end, ord };
  if (page !== undefined) c.page = page;
  return c;
};

const CHUNKS = [
  ch('p#0', 'polis.txt', 0, 28, 0, 1),
  ch('p#1', 'polis.txt', 29, 67, 1, 1),
  ch('p#2', 'polis.txt', 68, SRC.length, 2, 2),
  ch('o#0', 'other.txt', 0, 10, 0),
];
const byId = new Map(CHUNKS.map((c) => [c.id, c]));

test('link присоединяет текст чанков', () => {
  const r = link([{ id: 'p#0', score: 0.9 }], byId);
  assert.equal(r.length, 1);
  assert.equal(r[0]?.chunk.text, SRC.slice(0, 28));
  assert.equal(r[0]?.score, 0.9);
});

test('link определяет источник по ranks', () => {
  const r = link([
    { id: 'p#0', score: 1, ranks: [1, 2] },
    { id: 'p#1', score: 1, ranks: [1, -1] },
    { id: 'p#2', score: 1, ranks: [-1, 1] },
  ], byId, { limit: 9 });
  assert.equal(r[0]?.via, 'hybrid', 'найден обоими');
  assert.equal(r[1]?.via, 'lexical', 'только BM25');
  assert.equal(r[2]?.via, 'vector', 'только вектор');
});

test('link соблюдает limit', () => {
  const many = CHUNKS.map((c) => ({ id: c.id, score: 1 }));
  assert.equal(link(many, byId, { limit: 2 }).length, 2);
});

test('🔴 ссылка на удалённый чанк не падает, но ВИДНА через dropped()', () => {
  const ranked = [{ id: 'p#0', score: 1 }, { id: 'ghost#9', score: 1 }];
  const r = link(ranked, byId);
  assert.equal(r.length, 1, 'призрак не попал в выдачу');
  assert.deepEqual(dropped(ranked, byId), ['ghost#9'], 'но зафиксирован');
});

test('dropped пуст, когда всё на месте (контроль)', () => {
  assert.deepEqual(dropped([{ id: 'p#0' }], byId), []);
});

test('🟢 mergeAdjacent склеивает пересекающиеся чанки одного файла', () => {
  const cites = [
    { chunk: ch('a', 'f.txt', 0, 30), score: 0.9, via: /** @type {const} */ ('vector') },
    { chunk: ch('b', 'f.txt', 20, 50), score: 0.8, via: /** @type {const} */ ('vector') },
  ];
  const m = mergeAdjacent(cites);
  assert.equal(m.length, 1, 'склеились в один');
  assert.equal(m[0]?.chunk.start, 0);
  assert.equal(m[0]?.chunk.end, 50);
  assert.equal(m[0]?.score, 0.9, 'берётся лучшая оценка');
});

test('mergeAdjacent НЕ склеивает разные файлы', () => {
  const cites = [
    { chunk: ch('a', 'f1.txt', 0, 30), score: 0.9, via: /** @type {const} */ ('vector') },
    { chunk: ch('b', 'f2.txt', 10, 40), score: 0.8, via: /** @type {const} */ ('vector') },
  ];
  assert.equal(mergeAdjacent(cites).length, 2);
});

test('mergeAdjacent НЕ склеивает далёкие фрагменты одного файла (контроль)', () => {
  const cites = [
    { chunk: ch('a', 'f.txt', 0, 10), score: 0.9, via: /** @type {const} */ ('vector') },
    { chunk: ch('b', 'f.txt', 60, 80), score: 0.8, via: /** @type {const} */ ('vector') },
  ];
  assert.equal(mergeAdjacent(cites).length, 2, 'разрыв сохранён');
});

test('rehydrate восстанавливает дословный текст после склейки', () => {
  const cites = [
    { chunk: ch('a', 'polis.txt', 0, 28), score: 0.9, via: /** @type {const} */ ('vector') },
    { chunk: ch('b', 'polis.txt', 25, 60), score: 0.8, via: /** @type {const} */ ('vector') },
  ];
  const merged = mergeAdjacent(cites);
  assert.equal(merged[0]?.chunk.text, '', 'после склейки текст обнулён');
  const full = rehydrate(merged, () => SRC);
  assert.equal(full[0]?.chunk.text, SRC.slice(0, 60), 'дословная вырезка исходника');
});

test('rehydrate не трогает нетронутые цитаты', () => {
  const cites = [{ chunk: ch('a', 'polis.txt', 0, 28), score: 1, via: /** @type {const} */ ('vector') }];
  assert.equal(rehydrate(cites, () => 'ДРУГОЕ')[0]?.chunk.text, SRC.slice(0, 28));
});

// ---- валидатор структуры ----

const good = {
  sections: [
    { heading: 'Размер франшизы', refs: [{ chunkId: 'p#0' }] },
    { heading: 'Сроки', refs: [{ chunkId: 'p#1', start: 0, end: 10 }] },
  ],
};

test('🟢 валидная структура проходит', () => {
  assert.deepEqual(validateStructure(good, byId), []);
});

test('🔴 ССЫЛКА НА НЕСУЩЕСТВУЮЩИЙ ЧАНК — главный случай', () => {
  // именно это делает модель, когда галлюцинирует источник
  const bad = { sections: [{ heading: 'X', refs: [{ chunkId: 'выдумка#42' }] }] };
  const errs = validateStructure(bad, byId);
  assert.equal(errs.length, 1);
  assert.match(errs[0] ?? '', /не существует/);
});

test('🔴 интервал за границами чанка', () => {
  const bad = { sections: [{ heading: 'X', refs: [{ chunkId: 'p#0', start: 0, end: 9999 }] }] };
  assert.match(validateStructure(bad, byId)[0] ?? '', /вне чанка/);
});

test('отрицательный и вывернутый интервал', () => {
  assert.ok(validateStructure(
    { sections: [{ heading: 'X', refs: [{ chunkId: 'p#0', start: -5, end: 10 }] }] }, byId).length);
  assert.ok(validateStructure(
    { sections: [{ heading: 'X', refs: [{ chunkId: 'p#0', start: 20, end: 5 }] }] }, byId).length);
});

test('нецелые границы отвергаются', () => {
  const bad = { sections: [{ heading: 'X', refs: [{ chunkId: 'p#0', start: 1.5, end: 10 }] }] };
  assert.match(validateStructure(bad, byId)[0] ?? '', /нецелые/);
});

test('мусор вместо структуры', () => {
  for (const junk of [null, 'строка', 42, [], {}, { sections: 'нет' }, { sections: [] }]) {
    assert.ok(validateStructure(junk, byId).length > 0, `${JSON.stringify(junk)} должен быть отвергнут`);
  }
});

test('пустой heading и пустые refs отвергаются', () => {
  assert.ok(validateStructure({ sections: [{ heading: '', refs: [{ chunkId: 'p#0' }] }] }, byId).length);
  assert.ok(validateStructure({ sections: [{ heading: 'X', refs: [] }] }, byId).length);
});

test('ошибки собираются по ВСЕМ секциям, а не только первой', () => {
  const bad = {
    sections: [
      { heading: 'X', refs: [{ chunkId: 'нет#1' }] },
      { heading: 'Y', refs: [{ chunkId: 'нет#2' }] },
    ],
  };
  assert.equal(validateStructure(bad, byId).length, 2);
});

test('🟢 renderStructure ЦИТИРУЕТ дословно, не порождает текст', () => {
  const r = renderStructure(good, byId);
  assert.equal(r.length, 2);
  assert.equal(r[0]?.heading, 'Размер франшизы', 'заголовок от модели — допустимо');
  // а текст обязан быть вырезкой из чанка
  assert.equal(r[0]?.quotes[0]?.text, byId.get('p#0')?.text);
  assert.ok(SRC.includes(r[0]?.quotes[0]?.text ?? '@@@'), 'цитата есть в исходнике');
  assert.equal(r[1]?.quotes[0]?.text, byId.get('p#1')?.text.slice(0, 10));
});

test('renderStructure проставляет страницу, если она есть', () => {
  const r = renderStructure(good, byId);
  assert.equal(r[0]?.quotes[0]?.page, 1);
});

test('sourceLabel: имя файла и страница', () => {
  assert.equal(sourceLabel(ch('x', 'a/b/polis.pdf', 0, 5, 0, 3)), 'polis.pdf, с. 3');
  assert.equal(sourceLabel(ch('x', 'notes.txt', 0, 5)), 'notes.txt');
});
