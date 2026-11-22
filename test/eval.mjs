// Замер качества поиска на размеченном наборе.
//
// Это НЕ юнит-тест: он требует модели и реального индекса, идёт минуты.
// Запуск: node test/eval.mjs --dir /tmp/docs
//
// МЕТОДИКА (повторяет замер 2026-11-22, чтобы цифры были сопоставимы):
// разметка по ПОДСТРОКЕ целевого чанка, а не по id. Причина: id содержат
// порядковый номер и плывут при любом изменении параметров чанкинга, так
// что разметка по id молча «протухает» и начинает мерить не то.

import { Engine } from '../core/engine.mjs';
import { VectorStore } from '../core/vector.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** @type {Array<{q: string, expect: string}>} */
const QUESTIONS = [
  { q: 'сколько я плачу при аварии', expect: 'Франшиза по каждому страховому случаю' },
  { q: 'какая франшиза', expect: 'Франшиза по каждому страховому случаю' },
  { q: 'если ущерб совсем небольшой', expect: 'меньше суммы франшизы' },
  { q: 'когда придут деньги', expect: 'течение десяти рабочих дней' },
  { q: 'как быстро выплатят возмещение', expect: 'течение десяти рабочих дней' },
  { q: 'куда звонить ночью', expect: 'работает круглосуточно' },
  { q: 'можно ли пить за рулём', expect: 'алкогольного или наркотического опьянения' },
  { q: 'откажут ли в выплате пьяному', expect: 'не распространяется' },
  { q: 'когда дадут отпуск', expect: 'по согласованию с непосредственным руководителем' },
  { q: 'за сколько подавать заявление на отпуск', expect: 'четырнадцать календарных дней' },
  { q: 'декретный отпуск', expect: 'беременности и родам' },
  { q: 'что будет с неотгулянными днями', expect: 'переносятся на следующий календарный год' },
];

/**
 * @param {string} dir
 * @param {import('../core/engine.mjs').Embedder} embedder
 */
async function loadEngine(dir, embedder) {
  const engine = new Engine({ embedder });
  const raw = await readFile(join(dir, '.ragana', 'index.json'), 'utf8');
  const data = JSON.parse(raw);
  for (const f of data.files ?? []) engine.files.set(f.path, f);
  for (const c of data.chunks ?? []) engine.chunks.set(c.id, c);
  for (const [p, t] of data.sources ?? []) engine.sources.set(p, t);
  engine.vectors = VectorStore.deserialize({
    dim: data.vectors.dim,
    size: data.vectors.size,
    ids: data.vectors.ids,
    data: Float32Array.from(data.vectors.data),
  });
  for (const c of engine.chunks.values()) engine.bm25.add(c.id, c.text);
  return engine;
}

/**
 * @param {import('../core/engine.mjs').Engine} engine
 * @param {object} opts
 * @param {boolean} opts.expand
 * @param {'both'|'lexical'|'vector'} opts.mode
 * @param {number[]} [opts.weights]
 */
async function measure(engine, { expand, mode, weights }) {
  let r1 = 0, r3 = 0, r5 = 0, mrrSum = 0;
  /** @type {string[]} */
  const misses = [];

  for (const { q, expect } of QUESTIONS) {
    /** @type {string[]} */
    let texts = [];

    if (mode === 'lexical') {
      const hits = engine.bm25.search(
        expand ? (await import('../core/fusion.mjs')).expandQuery(q, (await import('../core/lexical.mjs')).stem).query : q,
        5,
      );
      texts = hits.map((h) => engine.chunks.get(h.id)?.text ?? '');
    } else if (mode === 'vector') {
      const { asQuery, expandQuery } = await import('../core/fusion.mjs');
      const { stem } = await import('../core/lexical.mjs');
      const query = expand ? expandQuery(q, stem).query : q;
      const [qv] = await engine.embedder.embed([asQuery(query)]);
      const hits = qv ? engine.vectors.search(qv, 5) : [];
      texts = hits.map((h) => engine.chunks.get(h.id)?.text ?? '');
    } else {
      const res = await engine.search(q, {
        k: 5, expand, merge: false,
        ...(weights ? { weights } : {}),
      });
      texts = res.citations.map((c) => c.chunk.text);
    }

    const rank = texts.findIndex((t) => t.includes(expect)) + 1;
    if (rank === 1) r1++;
    if (rank >= 1 && rank <= 3) r3++;
    if (rank >= 1 && rank <= 5) r5++;
    if (rank >= 1) mrrSum += 1 / rank;
    else misses.push(q);
  }

  const n = QUESTIONS.length;
  return { r1, r3, r5, n, mrr: mrrSum / n, misses };
}

const dirIndex = process.argv.indexOf('--dir');
const dir = dirIndex >= 0 ? process.argv[dirIndex + 1] ?? '/tmp/docs' : '/tmp/docs';

const { createEmbedder } = await import('../node/embedder.mjs');
process.stdout.write('загрузка модели... ');
const t0 = Date.now();
const embedder = await createEmbedder(
  join(process.cwd(), 'models/multilingual-e5-small'),
);
console.log(`${((Date.now() - t0) / 1000).toFixed(1)} с`);

const engine = await loadEngine(dir, embedder);
console.log(`индекс: ${engine.fileCount} файлов, ${engine.chunkCount} чанков\n`);

/** @type {Array<[string, {expand: boolean, mode: 'both'|'lexical'|'vector', weights?: number[]}]>} */
const configs = [
  ['BM25 сырой', { expand: false, mode: 'lexical' }],
  ['E5 сырой', { expand: false, mode: 'vector' }],
  ['E5 + расширение', { expand: true, mode: 'vector' }],
  ['гибрид 1:1', { expand: false, mode: 'both' }],
  ['гибрид 1:1 + расшир.', { expand: true, mode: 'both' }],
  ['гибрид 1:3 + расшир.', { expand: true, mode: 'both', weights: [1, 3] }],
  ['гибрид 1:5 + расшир.', { expand: true, mode: 'both', weights: [1, 5] }],
];

console.log('метод                  R@1    R@3    R@5    MRR');
console.log('---------------------- ------ ------ ------ -----');
/** @type {Record<string, string[]>} */
const allMisses = {};
for (const [name, cfg] of configs) {
  const m = await measure(engine, cfg);
  console.log(
    `${name.padEnd(22)} ${String(m.r1 + '/' + m.n).padEnd(6)} ` +
    `${String(m.r3 + '/' + m.n).padEnd(6)} ${String(m.r5 + '/' + m.n).padEnd(6)} ` +
    `${m.mrr.toFixed(2)}`,
  );
  allMisses[name] = m.misses;
}

const lastMisses = allMisses['гибрид + расширение'] ?? [];
if (lastMisses.length) {
  console.log('\nне найдено лучшим методом:');
  for (const q of lastMisses) console.log(`  — ${q}`);
}
