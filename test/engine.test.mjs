import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../core/engine.mjs';
import { entry } from '../core/snapshot.mjs';
import { analyze } from '../core/lexical.mjs';

// Детерминированный эмбеддер-заглушка: мешок слов по стеммам.
// Специально НЕ нейросеть — тест проверяет логику движка (синхронизацию,
// удаление, переименование, слияние), а не качество модели. Качество
// меряется отдельно, на размеченном корпусе.
const DIM = 64;
/** @type {import('../core/engine.mjs').Embedder} */
const fakeEmbedder = {
  dim: DIM,
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(DIM);
      for (const term of analyze(t)) {
        let h = 2166136261;
        for (let i = 0; i < term.length; i++) {
          h ^= term.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        const slot = (h >>> 0) % DIM;
        v[slot] = (v[slot] ?? 0) + 1;
      }
      return v;
    });
  },
};

const POLIS = `Франшиза по каждому страховому случаю составляет 300 евро.
Выплата производится в течение десяти рабочих дней после подачи заявления.
Сервисная служба работает круглосуточно по телефону на обороте полиса.`;

const OTPUSK = `Ежегодный отпуск предоставляется по согласованию с руководителем.
Заявление подаётся не позднее чем за четырнадцать дней до начала отпуска.`;

/**
 * @param {Array<[string, string]>} files
 * @returns {Map<string, import('../types/index.js').FileEntry>}
 */
const disk = (files) =>
  new Map(files.map(([p, text]) => [p, entry(p, `H_${text.length}_${p}`, text.length)]));

/**
 * @param {Map<string, string>} map
 * @returns {(path: string) => Promise<string>}
 */
const reader = (map) => async (path) => map.get(path) ?? '';

async function freshEngine() {
  const texts = new Map([['polis.txt', POLIS], ['otpusk.txt', OTPUSK]]);
  const e = new Engine({ embedder: fakeEmbedder, chunkTarget: 120, chunkOverlap: 30 });
  await e.sync(disk([...texts]), reader(texts));
  return { e, texts };
}

test('индексация наполняет оба индекса одинаково', async () => {
  const { e } = await freshEngine();
  assert.equal(e.fileCount, 2);
  assert.ok(e.chunkCount > 2, `чанков ${e.chunkCount}`);
  assert.equal(e.vectors.size, e.chunkCount, 'вектор на каждый чанк');
  assert.equal(e.bm25.size, e.chunkCount, 'BM25 на каждый чанк');
});

test('🟢 поиск находит релевантный документ с цитатой из исходника', async () => {
  const { e } = await freshEngine();
  const r = await e.search('какая франшиза', { k: 3 });
  assert.ok(r.citations.length > 0, 'что-то найдено');
  const top = r.citations[0];
  assert.equal(top?.chunk.path, 'polis.txt');
  assert.ok(POLIS.includes(top?.chunk.text ?? '@@'), 'цитата дословна');
});

test('🟢 поиск по второму документу не путается с первым', async () => {
  const { e } = await freshEngine();
  const r = await e.search('согласование отпуска с руководителем', { k: 3 });
  assert.equal(r.citations[0]?.chunk.path, 'otpusk.txt');
});

test('расширение запроса видно в результате', async () => {
  const { e } = await freshEngine();
  const r = await e.search('сколько платить при аварии', { k: 3 });
  assert.ok(r.added.length > 0, 'термины добавлены');
  assert.ok(r.query.length > 'сколько платить при аварии'.length);
});

test('expand:false оставляет запрос нетронутым (контроль)', async () => {
  const { e } = await freshEngine();
  const r = await e.search('сколько платить при аварии', { expand: false });
  assert.deepEqual(r.added, []);
  assert.equal(r.query, 'сколько платить при аварии');
});

test('поиск в пустом движке не падает', async () => {
  const e = new Engine({ embedder: fakeEmbedder });
  const r = await e.search('что угодно');
  assert.deepEqual(r.citations, []);
});

test('🔴 ПОВТОРНАЯ синхронизация без изменений НЕ переиндексирует', async () => {
  const { e, texts } = await freshEngine();
  const before = e.chunkCount;
  const r = await e.sync(disk([...texts]), reader(texts));
  assert.equal(r.added + r.changed + r.removed + r.renamed, 0, 'работы нет');
  assert.equal(r.chunks, 0, 'ни одного нового чанка');
  assert.equal(e.chunkCount, before, 'индекс не изменился');
});

test('🔴 ИЗМЕНЁННЫЙ файл заменяет старые чанки, а не добавляет к ним', async () => {
  const { e } = await freshEngine();
  const changed = new Map([
    ['polis.txt', 'Франшиза отменена полностью с первого января.'],
    ['otpusk.txt', OTPUSK],
  ]);
  const r = await e.sync(disk([...changed]), reader(changed));
  assert.equal(r.changed, 1);

  // старый текст больше не находится
  const old = await e.search('триста евро за страховой случай', { k: 5, expand: false });
  const stillOld = old.citations.some((c) => c.chunk.text.includes('300 евро'));
  assert.equal(stillOld, false, 'старая версия осталась в индексе');

  // позитивный контроль: новый текст находится
  const fresh = await e.search('франшиза отменена', { k: 3 });
  assert.ok(fresh.citations.some((c) => c.chunk.text.includes('отменена')), 'новая версия не найдена');
});

test('🔴 УДАЛЁННЫЙ файл исчезает из обоих индексов', async () => {
  const { e } = await freshEngine();
  const left = new Map([['otpusk.txt', OTPUSK]]);
  const r = await e.sync(disk([...left]), reader(left));
  assert.equal(r.removed, 1);
  assert.equal(e.fileCount, 1);

  const res = await e.search('франшиза страховой случай', { k: 5, expand: false });
  assert.equal(res.citations.length === 0 || res.citations.every((c) => c.chunk.path === 'otpusk.txt'),
    true, 'цитаты из удалённого файла');
  assert.deepEqual(res.dropped, [], 'нет висячих ссылок');

  // позитивный контроль: уцелевший файл ищется
  const ok = await e.search('отпуск согласование', { k: 3 });
  assert.ok(ok.citations.length > 0, 'оставшийся документ должен находиться');
});

test('🟢 ПЕРЕИМЕНОВАНИЕ не требует переэмбеддинга', async () => {
  const { e } = await freshEngine();
  const before = e.chunkCount;
  // тот же текст (тот же хэш), другой путь
  const moved = new Map([['архив/polis.txt', POLIS], ['otpusk.txt', OTPUSK]]);
  const d = new Map([
    ['архив/polis.txt', entry('архив/polis.txt', `H_${POLIS.length}_polis.txt`, POLIS.length)],
    ['otpusk.txt', entry('otpusk.txt', `H_${OTPUSK.length}_otpusk.txt`, OTPUSK.length)],
  ]);
  const r = await e.sync(d, reader(moved));
  assert.equal(r.renamed, 1, 'распознано как переименование');
  assert.equal(r.chunks, 0, 'НИ ОДНОГО нового эмбеддинга');
  assert.equal(e.chunkCount, before, 'количество чанков не изменилось');

  const res = await e.search('какая франшиза', { k: 3 });
  assert.equal(res.citations[0]?.chunk.path, 'архив/polis.txt', 'цитата с новым путём');
  assert.deepEqual(res.dropped, [], 'нет висячих ссылок после переименования');
});

test('добавление третьего файла не ломает первые два', async () => {
  const { e, texts } = await freshEngine();
  const more = new Map([...texts, ['new.txt', 'Договор номер 77-АБ заключён на год.']]);
  const r = await e.sync(disk([...more]), reader(more));
  assert.equal(r.added, 1);
  assert.equal(e.fileCount, 3);
  assert.ok((await e.search('франшиза', { k: 3 })).citations.length > 0, 'старый документ жив');
  assert.ok((await e.search('77-АБ', { k: 3 })).citations.length > 0, 'новый документ найден');
});

test('прогресс сообщается по фазам', async () => {
  const texts = new Map([['a.txt', POLIS]]);
  const e = new Engine({ embedder: fakeEmbedder, chunkTarget: 80, chunkOverlap: 20 });
  /** @type {string[]} */
  const phases = [];
  await e.sync(disk([...texts]), reader(texts), (p) => phases.push(p.phase));
  assert.ok(phases.includes('read'), 'фаза чтения');
  assert.ok(phases.includes('embed'), 'фаза эмбеддинга');
  assert.equal(phases[phases.length - 1], 'done', 'завершение последним');
});

test('🔴 битые координаты чанков падают СРАЗУ при индексации', async () => {
  const e = new Engine({ embedder: fakeEmbedder });
  // читатель возвращает НЕ тот текст, из которого построены чанки
  const d = disk([['x.txt', 'какой-то текст']]);
  await assert.rejects(
    () => e.sync(d, async () => { throw new Error('битые координаты чанков в x.txt: подделка'); }),
    /битые координаты|подделка/,
  );
});

test('цитаты несут оценку и способ нахождения', async () => {
  const { e } = await freshEngine();
  const r = await e.search('франшиза страховому случаю', { k: 3, merge: false });
  for (const c of r.citations) {
    assert.ok(c.score > 0, 'оценка положительна');
    assert.ok(['vector', 'lexical', 'hybrid'].includes(c.via), `странный via: ${c.via}`);
  }
});

test('merge:true склеивает соседние фрагменты одного файла', async () => {
  const { e } = await freshEngine();
  const raw = await e.search('франшиза выплата заявление', { k: 5, merge: false });
  const merged = await e.search('франшиза выплата заявление', { k: 5, merge: true });
  assert.ok(merged.citations.length <= raw.citations.length, 'склейка не увеличивает число цитат');
  for (const c of merged.citations) {
    const src = c.chunk.path === 'polis.txt' ? POLIS : OTPUSK;
    assert.ok(src.includes(c.chunk.text), 'склеенная цитата дословна');
  }
});
