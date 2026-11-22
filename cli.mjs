#!/usr/bin/env node
// ragana — локальный RAG по папке с документами.
//
//   ragana index --dir ./docs            проиндексировать (только изменения)
//   ragana ask   --dir ./docs "вопрос"   спросить с цитатами
//   ragana status --dir ./docs           что в индексе
//   ragana reset --dir ./docs            сбросить индекс

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { Engine } from './core/engine.mjs';
import { scanDir, readDocument } from './node/fs-scan.mjs';
import { sourceLabel } from './core/cite.mjs';
import { VectorStore } from './core/vector.mjs';
import { entry } from './core/snapshot.mjs';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};

// Флаги-переключатели НЕ принимают значение. Без этого списка
// `ask --dir X --json "вопрос"` съедал вопрос как значение --json,
// и команда жаловалась на отсутствие вопроса.
const BOOLEAN_FLAGS = new Set(['json', 'no-expand', 'help', 'quiet']);

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { _: /** @type {string[]} */ ([]), /** @type {Record<string,string|boolean>} */ flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key)) {
        out.flags[key] = true;
      } else if (next !== undefined && !next.startsWith('--')) {
        out.flags[key] = next;
        i++;
      } else {
        out.flags[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** @param {string} dir */
const indexPath = (dir) => join(dir, '.ragana', 'index.json');

/**
 * Сохранение индекса. Векторы кладутся как обычный массив чисел —
 * JSON не умеет Float32Array, а base64 экономил бы место ценой
 * нечитаемости файла, который полезно уметь открыть глазами.
 * @param {string} dir
 * @param {Engine} engine
 */
async function save(dir, engine) {
  await mkdir(join(dir, '.ragana'), { recursive: true });
  const v = engine.vectors.serialize();
  const data = {
    version: 1,
    savedAt: Date.now(),
    files: [...engine.files.values()],
    chunks: [...engine.chunks.values()],
    sources: [...engine.sources.entries()],
    vectors: { dim: v.dim, size: v.size, ids: v.ids, data: Array.from(v.data) },
  };
  await writeFile(indexPath(dir), JSON.stringify(data), 'utf8');
}

/**
 * @param {string} dir
 * @param {Engine} engine
 * @returns {Promise<boolean>}
 */
async function load(dir, engine) {
  let raw;
  try {
    raw = await readFile(indexPath(dir), 'utf8');
  } catch {
    return false;
  }
  const data = JSON.parse(raw);
  for (const f of data.files ?? []) engine.files.set(f.path, f);
  for (const c of data.chunks ?? []) engine.chunks.set(c.id, c);
  for (const [p, t] of data.sources ?? []) engine.sources.set(p, t);
  if (data.vectors) {
    engine.vectors = VectorStore.deserialize({
      dim: data.vectors.dim,
      size: data.vectors.size,
      ids: data.vectors.ids,
      data: Float32Array.from(data.vectors.data),
    });
  }
  for (const c of engine.chunks.values()) engine.bm25.add(c.id, c.text);
  return true;
}

/**
 * Эмбеддер выбирается по доступности модели. Если её нет — честный
 * отказ с инструкцией, а не молчаливая деградация к заглушке:
 * заглушка выдала бы правдоподобные, но бессмысленные результаты.
 * @param {string} modelDir
 */
async function makeEmbedder(modelDir) {
  const { createEmbedder } = await import('./node/embedder.mjs');
  return createEmbedder(modelDir);
}

/** @param {number} ms */
const human = (ms) => (ms < 1000 ? `${Math.round(ms)} мс` : `${(ms / 1000).toFixed(1)} с`);

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0];
  const dir = resolve(String(flags.dir ?? '.'));
  const modelDir = String(flags.model ?? join(process.cwd(), 'models/multilingual-e5-small'));

  if (!cmd || cmd === 'help' || flags.help) {
    console.log(`${C.b('ragana')} — локальный RAG по папке с документами

  ${C.c('ragana index')}  --dir <папка>            проиндексировать изменения
  ${C.c('ragana ask')}    --dir <папка> "вопрос"   спросить с цитатами
  ${C.c('ragana status')} --dir <папка>            состояние индекса
  ${C.c('ragana reset')}  --dir <папка>            удалить индекс

${C.dim('Флаги:')}
  --model <путь>   каталог модели (по умолчанию ./models/multilingual-e5-small)
  --k <N>          сколько цитат показать (по умолчанию 5)
  --no-expand      не расширять запрос синонимами
  --mode <режим>   hybrid (по умолчанию) | vector | lexical
  --json           машиночитаемый вывод`);
    return;
  }

  if (cmd === 'reset') {
    const { rm } = await import('node:fs/promises');
    await rm(join(dir, '.ragana'), { recursive: true, force: true });
    console.log(C.g('индекс удалён'));
    return;
  }

  if (cmd === 'status') {
    const engine = new Engine({ embedder: { dim: 384, embed: async () => [] } });
    const ok = await load(dir, engine);
    if (!ok) {
      console.log(C.y('индекса нет — запустите: ragana index --dir ' + dir));
      return;
    }
    console.log(`${C.b('папка')}   ${dir}`);
    console.log(`${C.b('файлов')}  ${engine.fileCount}`);
    console.log(`${C.b('чанков')}  ${engine.chunkCount}`);
    const bytes = [...engine.files.values()].reduce((s, f) => s + f.size, 0);
    console.log(`${C.b('объём')}   ${(bytes / 1048576).toFixed(2)} МБ`);
    return;
  }

  if (cmd === 'index') {
    const t0 = performance.now();
    process.stdout.write('загрузка модели... ');
    const embedder = await makeEmbedder(modelDir);
    console.log(C.dim(human(performance.now() - t0)));

    const engine = new Engine({ embedder });
    await load(dir, engine);

    process.stdout.write('сканирование... ');
    const { files, skipped } = await scanDir(dir, { prev: engine.files });
    console.log(`${files.size} файлов` + (skipped.length ? C.dim(`, пропущено ${skipped.length}`) : ''));
    for (const s of skipped.slice(0, 5)) console.log(C.dim(`  ~ ${s.path}: ${s.why}`));

    let lastFile = '';
    const res = await engine.sync(files, (p) => readDocument(dir, p), (pr) => {
      if (pr.file && pr.file !== lastFile) {
        lastFile = pr.file;
        process.stdout.write(`\r${' '.repeat(70)}\r${C.dim('→ ' + basename(pr.file))}`);
      }
      if (pr.phase === 'embed') {
        process.stdout.write(`\r${' '.repeat(70)}\r${C.dim(`→ ${basename(pr.file ?? '')} ${pr.done}/${pr.total}`)}`);
      }
    });
    process.stdout.write(`\r${' '.repeat(70)}\r`);

    await save(dir, engine);
    console.log(C.g('готово: ') + res.summary);
    console.log(C.dim(`чанков в индексе: ${engine.chunkCount}, время ${human(performance.now() - t0)}`));
    return;
  }

  if (cmd === 'ask') {
    const question = _.slice(1).join(' ').trim();
    if (!question) {
      console.error(C.r('укажите вопрос: ragana ask --dir ./docs "как оформить отпуск"'));
      process.exitCode = 1;
      return;
    }
    const embedder = await makeEmbedder(modelDir);
    const engine = new Engine({ embedder });
    if (!(await load(dir, engine))) {
      console.error(C.r('индекса нет — сначала: ragana index --dir ' + dir));
      process.exitCode = 1;
      return;
    }

    const t0 = performance.now();
    const r = await engine.search(question, {
      k: Number(flags.k ?? 5),
      expand: flags['no-expand'] !== true,
      mode: /** @type {'hybrid'|'vector'|'lexical'} */ (String(flags.mode ?? 'hybrid')),
    });
    const took = performance.now() - t0;

    if (flags.json) {
      console.log(JSON.stringify({
        question, query: r.query, added: r.added, tookMs: Math.round(took),
        citations: r.citations.map((c) => ({
          text: c.chunk.text, path: c.chunk.path, page: c.chunk.page,
          start: c.chunk.start, end: c.chunk.end, score: c.score, via: c.via,
        })),
      }, null, 2));
      return;
    }

    if (r.added.length) console.log(C.dim(`+ ${r.added.join(' ')}`));
    if (r.citations.length === 0) {
      console.log(C.y('ничего не найдено'));
      return;
    }
    console.log();
    r.citations.forEach((c, i) => {
      const via = c.via === 'hybrid' ? C.g('оба') : c.via === 'lexical' ? C.y('слова') : C.c('смысл');
      console.log(`${C.b(`[${i + 1}]`)} ${C.b(sourceLabel(c.chunk))}  ${C.dim(`${via} ${c.score.toFixed(4)}`)}`);
      console.log(`    ${c.chunk.text.replace(/\n/g, '\n    ')}`);
      console.log();
    });
    console.log(C.dim(`${r.citations.length} цитат за ${human(took)}`));
    if (r.dropped.length) console.log(C.r(`висячих ссылок: ${r.dropped.length} — переиндексируйте`));
    return;
  }

  console.error(C.r(`неизвестная команда: ${cmd}`));
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(C.r('ошибка: ') + (e?.message ?? String(e)));
  process.exitCode = 1;
});
