// Движок: связывает снимки, чанкинг, два индекса и цитаты.
//
// Эмбеддер передаётся СНАРУЖИ как интерфейс {dim, embed(texts)}. Причина:
// в Node это Transformers.js через файловый кэш, в WebView — он же через
// fetch-перехват, в расширении — возможно удалённый эндпоинт. Движок не
// должен знать, который из них.
//
// Хранилище тоже снаружи: в браузере IndexedDB, в CLI — JSON-файл.

import { VectorStore } from './vector.mjs';
import { BM25, stem } from './lexical.mjs';
import { chunkText, verifyOffsets } from './chunk.mjs';
import { rrf, expandQuery, asQuery, asPassage } from './fusion.mjs';
import { link, dropped, mergeAdjacent, rehydrate } from './cite.mjs';
import { diffSnapshots, hasWork, describe, pathsToPurge, pathsToIngest } from './snapshot.mjs';

/** @typedef {import('../types/index.js').Chunk} Chunk */
/** @typedef {import('../types/index.js').Citation} Citation */
/** @typedef {import('../types/index.js').FileEntry} FileEntry */

/**
 * @typedef {object} Embedder
 * @property {number} dim
 * @property {(texts: string[]) => Promise<Float32Array[]>} embed
 */

/**
 * @typedef {object} IndexProgress
 * @property {string} phase
 * @property {number} done
 * @property {number} total
 * @property {string} [file]
 */

export class Engine {
  /**
   * @param {object} opts
   * @param {Embedder} opts.embedder
   * @param {number} [opts.chunkTarget]
   * @param {number} [opts.chunkOverlap]
   */
  constructor({ embedder, chunkTarget = 900, chunkOverlap = 150 }) {
    this.embedder = embedder;
    this.chunkTarget = chunkTarget;
    this.chunkOverlap = chunkOverlap;
    this.vectors = new VectorStore(embedder.dim);
    this.bm25 = new BM25();
    /** @type {Map<string, Chunk>} */
    this.chunks = new Map();
    /** @type {Map<string, FileEntry>} */
    this.files = new Map();
    /** @type {Map<string, string>} путь -> извлечённый текст (для цитат) */
    this.sources = new Map();
  }

  get chunkCount() {
    return this.chunks.size;
  }

  get fileCount() {
    return this.files.size;
  }

  /**
   * Полная синхронизация с состоянием диска.
   *
   * @param {Map<string, FileEntry>} disk текущий снимок
   * @param {(path: string) => Promise<string>} readText как получить текст
   * @param {(p: IndexProgress) => void} [onProgress]
   * @returns {Promise<{added: number, changed: number, removed: number, renamed: number, chunks: number, summary: string}>}
   */
  async sync(disk, readText, onProgress) {
    const prev = this.files;
    const d = diffSnapshots(
      new Map([...disk].map(([p, e]) => [p, { hash: e.hash, size: e.size }])),
      new Map([...prev].map(([p, e]) => [p, { hash: e.hash, size: e.size }])),
    );

    // 1. Переименования — без переэмбеддинга, только смена пути
    for (const r of d.renamed) {
      this._renamePath(r.from, r.to);
    }

    // 2. Удаление устаревших чанков ДО добавления новых: иначе в выдаче
    // окажутся обе версии изменённого документа
    const purge = pathsToPurge(d);
    if (purge.length) this._purge(purge);

    // 3. Индексация новых и изменённых
    const toIngest = pathsToIngest(d);
    let newChunks = 0;
    for (let i = 0; i < toIngest.length; i++) {
      const path = toIngest[i];
      if (path === undefined) continue;
      onProgress?.({ phase: 'read', done: i, total: toIngest.length, file: path });
      const text = await readText(path);
      newChunks += await this._ingest(path, text, (done, total) => {
        onProgress?.({ phase: 'embed', done, total, file: path });
      });
      const entry = disk.get(path);
      if (entry) this.files.set(path, entry);
    }

    // 4. Актуализация записей о неизменившихся (на случай новых полей)
    for (const path of d.same) {
      const entry = disk.get(path);
      if (entry) this.files.set(path, entry);
    }

    onProgress?.({ phase: 'done', done: toIngest.length, total: toIngest.length });

    return {
      added: d.added.length,
      changed: d.changed.length,
      removed: d.removed.length,
      renamed: d.renamed.length,
      chunks: newChunks,
      summary: hasWork(d) ? describe(d) : describe(d),
    };
  }

  /**
   * @param {string} path
   * @param {string} text
   * @param {(done: number, total: number) => void} [onProgress]
   * @returns {Promise<number>}
   */
  async _ingest(path, text, onProgress) {
    const chunks = chunkText(text, {
      path,
      target: this.chunkTarget,
      overlap: this.chunkOverlap,
    });
    if (chunks.length === 0) return 0;

    // Инвариант координат проверяется ПРИ ИНДЕКСАЦИИ, а не только в тестах:
    // битые координаты обязаны падать сразу, а не всплыть неверной цитатой
    const bad = verifyOffsets(text, chunks);
    if (bad.length) {
      throw new Error(`битые координаты чанков в ${path}: ${bad[0]}`);
    }

    this.sources.set(path, text);

    // Эмбеддинги пачками: 438 мс на текст, прогресс нужен обязательно
    const BATCH = 8;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const slice = chunks.slice(i, i + BATCH);
      const vecs = await this.embedder.embed(slice.map((c) => asPassage(c.text)));
      slice.forEach((c, j) => {
        const v = vecs[j];
        if (!v) return;
        this.chunks.set(c.id, c);
        this.vectors.add(c.id, v);
        this.bm25.add(c.id, c.text);
      });
      onProgress?.(Math.min(i + BATCH, chunks.length), chunks.length);
    }
    return chunks.length;
  }

  /**
   * @param {string[]} paths
   */
  _purge(paths) {
    const set = new Set(paths);
    /** @type {(id: string) => boolean} */
    const doomed = (id) => {
      const c = this.chunks.get(id);
      return c ? set.has(c.path) : true;
    };
    this.vectors.removeWhere(doomed);
    this.bm25.removeWhere(doomed, (id) => this.chunks.get(id)?.text);
    for (const [id, c] of [...this.chunks]) {
      if (set.has(c.path)) this.chunks.delete(id);
    }
    for (const p of paths) {
      this.files.delete(p);
      this.sources.delete(p);
    }
  }

  /**
   * Переименование: чанки сохраняются, меняется только путь и id.
   * @param {string} from
   * @param {string} to
   */
  _renamePath(from, to) {
    /** @type {Array<[string, string]>} старый id -> новый id */
    const remap = [];
    for (const [id, c] of [...this.chunks]) {
      if (c.path !== from) continue;
      const newId = `${to}#${c.ord}`;
      this.chunks.delete(id);
      this.chunks.set(newId, { ...c, id: newId, path: to });
      remap.push([id, newId]);
    }
    for (const [oldId, newId] of remap) {
      const i = this.vectors.ids.indexOf(oldId);
      if (i >= 0) this.vectors.ids[i] = newId;
      const j = this.bm25.ids.indexOf(oldId);
      if (j >= 0) this.bm25.ids[j] = newId;
    }
    const entry = this.files.get(from);
    if (entry) {
      this.files.delete(from);
      this.files.set(to, { ...entry, path: to });
    }
    const src = this.sources.get(from);
    if (src !== undefined) {
      this.sources.delete(from);
      this.sources.set(to, src);
    }
  }

  /**
   * Поиск: расширение запроса -> BM25 + вектор -> RRF -> цитаты.
   *
   * @param {string} question
   * @param {object} [opts]
   * @param {number} [opts.k] сколько цитат вернуть
   * @param {number} [opts.pool] глубина каждого списка до слияния
   * @param {boolean} [opts.expand] расширять ли запрос
   * @param {boolean} [opts.merge] склеивать ли соседние цитаты
   * @returns {Promise<{citations: Citation[], query: string, added: string[], dropped: string[]}>}
   */
  async search(question, { k = 5, pool = 20, expand = true, merge = true } = {}) {
    const exp = expand ? expandQuery(question, stem) : { query: question, added: [] };

    const lex = this.bm25.search(exp.query, pool);

    let vec = /** @type {import('../types/index.js').Hit[]} */ ([]);
    if (this.vectors.size > 0) {
      const [qv] = await this.embedder.embed([asQuery(exp.query)]);
      if (qv) vec = this.vectors.search(qv, pool);
    }

    const fused = rrf([lex, vec], { limit: Math.max(k * 3, pool) });
    const lost = dropped(fused, this.chunks);
    let cites = link(fused, this.chunks, { limit: merge ? k * 2 : k });
    if (merge) {
      cites = rehydrate(mergeAdjacent(cites), (p) => this.sources.get(p)).slice(0, k);
    }

    return { citations: cites, query: exp.query, added: exp.added, dropped: lost };
  }
}
