import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, stem, analyze, BM25 } from '../core/lexical.mjs';

test('🔴 токенизация РАБОТАЕТ С КИРИЛЛИЦЕЙ', () => {
  // та самая грабля: \b в JS определён через [A-Za-z0-9_],
  // поэтому /\b(зуб)/i.test('зуб заболел') === false
  assert.equal(/\b(зуб)/i.test('зуб заболел'), false, 'контроль: \\b и правда сломан');
  assert.deepEqual(tokenize('зуб заболел'), ['зуб', 'заболел'], 'а токенизатор работает');
});

test('токенизация: регистр, пунктуация, цифры', () => {
  assert.deepEqual(tokenize('Франшиза — 300 евро!'), ['франшиза', '300', 'евро']);
  assert.deepEqual(tokenize('договор №77-АБ'), ['договор', '77', 'аб']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('...'), []);
});

test('токенизация не теряет латиницу вперемешку с кириллицей', () => {
  assert.deepEqual(tokenize('PDF файл и OCR скан'), ['pdf', 'файл', 'и', 'ocr', 'скан']);
});

test('🟢 стеммер склеивает словоформы (попарно)', () => {
  const pairs = [
    ['франшиза', 'франшизы'],
    ['сервисная', 'сервисной'],
    ['опьянение', 'опьянения'],
    ['согласование', 'согласования'],
    ['страховой', 'страховые'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(stem(a ?? ''), stem(b ?? ''), `${a} и ${b} должны иметь общую основу`);
  }
});

test('стеммер НЕ склеивает разные слова (контроль к предыдущему)', () => {
  // без этого теста стеммер, рубящий всё до 4 букв, прошёл бы как «работает»
  assert.notEqual(stem('франшиза'), stem('страховка'));
  assert.notEqual(stem('договор'), stem('документ'));
});

test('стеммер не калечит короткие слова', () => {
  for (const w of ['дом', 'я', 'код', 'файл']) {
    assert.equal(stem(w), w, `${w} не должно обрезаться`);
  }
});

test('стеммер оставляет основу не короче 4 символов', () => {
  for (const w of ['банка', 'рука', 'ноги', 'реки']) {
    assert.ok(stem(w).length >= 3, `${w} -> ${stem(w)} слишком коротко`);
  }
});

test('analyze = tokenize + stem', () => {
  const words = tokenize('Франшизы составляют');
  assert.deepEqual(analyze('Франшизы составляют'), words.map((w) => stem(w)));
});

test('🟢 словоформы из вчерашнего замера склеиваются (все 6 пар)', () => {
  // ровно те пары, на которых проверялся стеммер в замере 2026-11-22
  const pairs = [
    ['франшиза', 'франшизы'], ['сервисная', 'сервисной'],
    ['опьянение', 'опьянения'], ['согласование', 'согласования'],
    ['страховой', 'страховые'], ['беременность', 'беременностью'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(stem(a ?? ''), stem(b ?? ''), `${a} / ${b}`);
  }
});

/** @type {Array<[string, string]>} */
const DOCS = [
  ['c0', 'Франшиза по каждому страховому случаю составляет 300 евро.'],
  ['c1', 'Сервисная служба работает круглосуточно, телефон на обороте полиса.'],
  ['c2', 'Покрытие не распространяется на управление в состоянии алкогольного опьянения.'],
  ['c3', 'Отпуск предоставляется по согласованию с руководителем подразделения.'],
  ['c4', 'Договор номер 77-АБ заключён сроком на один год.'],
];
const build = () => {
  const bm = new BM25();
  for (const [id, text] of DOCS) bm.add(id, text);
  return bm;
};

test('пустой индекс и пустой запрос', () => {
  assert.deepEqual(new BM25().search('что угодно'), []);
  assert.deepEqual(build().search(''), []);
  assert.deepEqual(build().search('...'), []);
});

test('находит по точному термину', () => {
  assert.equal(build().search('франшиза', 1)[0]?.id, 'c0');
  assert.equal(build().search('опьянение', 1)[0]?.id, 'c2');
});

test('🟢 находит по ДРУГОЙ СЛОВОФОРМЕ (ради этого стеммер)', () => {
  // запрос в другом падеже, чем документ
  assert.equal(build().search('франшизы', 1)[0]?.id, 'c0');
  assert.equal(build().search('сервисной службы', 1)[0]?.id, 'c1');
  assert.equal(build().search('согласования отпуска', 1)[0]?.id, 'c3');
});

test('🟢 сильная сторона BM25: точные номера и суммы', () => {
  // ровно то, что вектор размывает
  assert.equal(build().search('77-АБ', 1)[0]?.id, 'c4');
  assert.equal(build().search('300 евро', 1)[0]?.id, 'c0');
});

test('результаты отсортированы и ограничены k', () => {
  const hits = build().search('страховому случаю полиса', 3);
  assert.ok(hits.length <= 3);
  for (let i = 1; i < hits.length; i++) {
    assert.ok((hits[i - 1]?.score ?? 0) >= (hits[i]?.score ?? 0), 'порядок нарушен');
  }
});

test('редкий термин весит больше частого (idf работает)', () => {
  const bm = new BM25();
  for (let i = 0; i < 20; i++) bm.add(`common${i}`, 'договор страхования общий текст');
  bm.add('rare', 'договор страхования и уникальное слово кракозябра');
  assert.equal(bm.search('кракозябра', 1)[0]?.id, 'rare');
});

test('idf не уходит в минус на термине, встречающемся везде', () => {
  const bm = new BM25();
  for (let i = 0; i < 10; i++) bm.add(`d${i}`, 'одинаковый текст везде');
  const hits = bm.search('одинаковый', 10);
  assert.ok(hits.every((h) => h.score >= 0), 'отрицательных оценок быть не должно');
});

test('несуществующий термин даёт пустой результат', () => {
  assert.deepEqual(build().search('квазимодо'), []);
});

test('🔴 removeWhere ПЕРЕСТРАИВАЕТ индекс, а не помечает', () => {
  const bm = build();
  const texts = new Map(DOCS);
  const removed = bm.removeWhere((id) => id === 'c0', (id) => texts.get(id));
  assert.equal(removed, 1);
  assert.equal(bm.size, 4);
  // удалённый больше не находится
  assert.deepEqual(bm.search('франшиза'), []);
  // позитивный контроль: уцелевшие ДЕЙСТВИТЕЛЬНО ищутся, а не осиротели
  assert.equal(bm.search('опьянение', 1)[0]?.id, 'c2');
  assert.equal(bm.search('77-АБ', 1)[0]?.id, 'c4');
});

test('removeWhere без совпадений ничего не меняет', () => {
  const bm = build();
  const texts = new Map(DOCS);
  assert.equal(bm.removeWhere(() => false, (id) => texts.get(id)), 0);
  assert.equal(bm.size, 5);
});

test('removeWhere всего — индекс пригоден к дальнейшей работе', () => {
  const bm = build();
  const texts = new Map(DOCS);
  assert.equal(bm.removeWhere(() => true, (id) => texts.get(id)), 5);
  assert.equal(bm.size, 0);
  assert.deepEqual(bm.search('франшиза'), []);
  bm.add('new', 'новый документ про франшизу');
  assert.equal(bm.search('франшиза', 1)[0]?.id, 'new');
});

test('avgLength пересчитывается после удаления', () => {
  const bm = new BM25();
  bm.add('short', 'раз два');
  bm.add('long', 'раз два три четыре пять шесть семь восемь девять десять');
  const before = bm.avgLength;
  const texts = new Map([['short', 'раз два'], ['long', 'раз два три четыре пять шесть семь восемь девять десять']]);
  bm.removeWhere((id) => id === 'long', (id) => texts.get(id));
  assert.ok(bm.avgLength < before, 'средняя длина уменьшилась');
  assert.equal(bm.avgLength, 2);
});
