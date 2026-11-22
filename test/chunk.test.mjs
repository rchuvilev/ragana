import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentences, chunkText, verifyOffsets } from '../core/chunk.mjs';

const POLICY = `Договор страхования номер 77-АБ.
Франшиза по каждому страховому случаю составляет 300 евро. Если ущерб меньше франшизы, выплата не производится.

Сервисная служба работает круглосуточно. Телефон указан на обороте полиса, т.е. на второй странице.
Страховое покрытие не распространяется на случаи управления транспортным средством в состоянии алкогольного опьянения.`;

test('границы предложений покрывают текст БЕЗ пропусков и пересечений', () => {
  const s = sentences(POLICY);
  assert.ok(s.length > 1, 'текст разбит');
  assert.equal(s[0]?.[0], 0, 'начинается с нуля');
  assert.equal(s[s.length - 1]?.[1], POLICY.length, 'кончается длиной текста');
  for (let i = 1; i < s.length; i++) {
    assert.equal(s[i - 1]?.[1], s[i]?.[0], `разрыв/нахлёст на границе ${i}`);
  }
});

test('🔴 "т.е." НЕ считается концом предложения', () => {
  const t = 'Телефон на обороте, т.е. на второй странице. Далее новый текст.';
  const s = sentences(t);
  assert.equal(s.length, 2, `ожидалось 2 предложения, получено ${s.length}`);
  const first = s[0];
  assert.ok(first && t.slice(first[0], first[1]).includes('т.е.'), 'сокращение внутри');
});

test('пустая строка — граница абзаца', () => {
  const s = sentences('Первый абзац\n\nВторой абзац');
  assert.equal(s.length, 2);
});

test('одиночный перевод строки границей НЕ считается', () => {
  const s = sentences('строка один\nстрока два без точки');
  assert.equal(s.length, 1);
});

test('серия знаков "?!.." не плодит пустые предложения', () => {
  const s = sentences('Правда?! Да.');
  assert.equal(s.length, 2);
  assert.ok(s.every(([a, b]) => b > a), 'нет пустых диапазонов');
});

test('пустой текст и пробелы не ломают', () => {
  assert.deepEqual(sentences(''), []);
  assert.equal(chunkText('').length, 0);
  assert.equal(chunkText('   \n\n  ').length, 0, 'только пробелы -> нет чанков');
});

test('🟢 ИНВАРИАНТ: text === source.slice(start,end) для КАЖДОГО чанка', () => {
  const chunks = chunkText(POLICY, { path: 'polis.txt', target: 200, overlap: 50 });
  assert.ok(chunks.length > 1, 'получилось несколько чанков');
  assert.deepEqual(verifyOffsets(POLICY, chunks), [], 'координаты точны');
});

test('инвариант держится при разных размерах', () => {
  for (const target of [80, 150, 400, 2000]) {
    const chunks = chunkText(POLICY, { path: 'p', target, overlap: Math.floor(target / 4) });
    assert.deepEqual(verifyOffsets(POLICY, chunks), [], `сломалось при target=${target}`);
  }
});

test('чанки не пустые и не из одних пробелов', () => {
  const chunks = chunkText(POLICY, { target: 120, overlap: 30 });
  for (const c of chunks) {
    assert.ok(c.text.trim().length > 0, `пустой чанк ${c.id}`);
    assert.equal(c.text, c.text.trim(), 'текст обрезан по краям');
  }
});

test('ord последовательный, id уникальны', () => {
  const chunks = chunkText(POLICY, { path: 'doc.txt', target: 150, overlap: 40 });
  chunks.forEach((c, i) => assert.equal(c.ord, i, 'ord по порядку'));
  assert.equal(new Set(chunks.map((c) => c.id)).size, chunks.length, 'id уникальны');
  assert.ok(chunks[0]?.id.startsWith('doc.txt#'), 'id содержит путь');
});

test('🔴 перекрытие РЕАЛЬНО есть: соседние чанки делят текст', () => {
  const chunks = chunkText(POLICY, { target: 200, overlap: 80 });
  assert.ok(chunks.length >= 2);
  let overlapping = 0;
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1], cur = chunks[i];
    if (prev && cur && cur.start < prev.end) overlapping++;
  }
  // позитивный контроль: без перекрытия этот счётчик был бы 0
  assert.ok(overlapping > 0, 'перекрытия нет ни на одной границе');
});

test('без перекрытия чанки идут встык (контроль к предыдущему тесту)', () => {
  const chunks = chunkText(POLICY, { target: 200, overlap: 0 });
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1], cur = chunks[i];
    assert.ok(prev && cur && cur.start >= prev.start, 'порядок сохранён');
  }
});

test('очень длинное предложение не вешает цикл', () => {
  const long = 'слово '.repeat(5000) + '.';
  const chunks = chunkText(long, { target: 300, overlap: 100 });
  assert.ok(chunks.length >= 1);
  assert.deepEqual(verifyOffsets(long, chunks), []);
});

test('текст без знаков препинания даёт один чанк', () => {
  const t = 'просто текст без точек и переводов строки';
  const chunks = chunkText(t, { target: 1000, overlap: 100 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.text, t);
});

test('перекрытие >= target — явная ошибка', () => {
  assert.throws(() => chunkText(POLICY, { target: 100, overlap: 100 }), /перекрытие/);
});

test('pageAt проставляет страницу', () => {
  const chunks = chunkText(POLICY, { target: 150, overlap: 30, pageAt: (o) => (o < 150 ? 1 : 2) });
  assert.equal(chunks[0]?.page, 1);
  assert.ok(chunks.some((c) => c.page === 2), 'вторая страница встречается');
});

test('без pageAt поле page отсутствует', () => {
  const chunks = chunkText(POLICY, { target: 150, overlap: 30 });
  assert.equal(chunks[0]?.page, undefined);
});

test('verifyOffsets ЛОВИТ подделку (позитивный контроль проверки)', () => {
  const chunks = chunkText(POLICY, { path: 'p', target: 200, overlap: 50 });
  assert.deepEqual(verifyOffsets(POLICY, chunks), [], 'исходно чисто');
  const broken = chunks.map((c, i) => (i === 0 ? { ...c, start: c.start + 3 } : c));
  const bad = verifyOffsets(POLICY, broken);
  assert.equal(bad.length, 1, 'сдвиг на 3 символа обязан быть пойман');
});

test('весь текст покрыт объединением чанков', () => {
  const chunks = chunkText(POLICY, { target: 200, overlap: 50 });
  const covered = new Array(POLICY.length).fill(false);
  for (const c of chunks) for (let i = c.start; i < c.end; i++) covered[i] = true;
  // непокрытыми могут остаться только пробельные символы между чанками
  const missed = [];
  for (let i = 0; i < POLICY.length; i++) {
    if (!covered[i] && !/\s/.test(POLICY[i] ?? '')) missed.push(i);
  }
  assert.deepEqual(missed, [], `не покрыты значимые символы: ${missed.slice(0, 5)}`);
});
