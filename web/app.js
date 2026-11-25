// Веб-слой ragana. Одна и та же сборка работает:
//   - в Android WebView (через виртуальный origin, см. android/)
//   - как страница Chrome-расширения
//   - в обычном браузере
//
// Поэтому здесь нет ни одного обращения к Node API, а хранилище —
// IndexedDB, единственное, доступное во всех трёх средах одинаково.

import { Engine } from '../core/engine.mjs';
import { VectorStore } from '../core/vector.mjs';
import { hashBytes, entry } from '../core/snapshot.mjs';
import { detect, isSupported, parserVersionFor, formatInfo } from '../core/formats.mjs';
import { sourceLabel } from '../core/cite.mjs';
import { mountSearch } from './ui.js';
import { Store } from '../core/store.mjs';

const $ = (id) => /** @type {any} */ (document.getElementById(id));

const ui = {
  setup: $('setup'), status: $('status'), ask: $('ask'), results: $('results'),
  pick: $('btn-pick'), folder: $('btn-folder'), files: $('btn-files'),
  fileInput: $('file-input'), fallbackNote: $('fallback-note'),
  index: $('btn-index'), reset: $('btn-reset'),
  indexTop: $('btn-index-top'), resetTop: $('btn-reset-top'),
  searchRoot: $('search-root'),
  statFiles: $('stat-files'), statChunks: $('stat-chunks'), statDir: $('stat-dir'),
  progress: $('progress'), bar: $('bar'), progressText: $('progress-text'),
  diff: $('diff'), toast: $('toast'),
};

/** @type {{engine: Engine|null, store: Store|null, dirHandle: any, root: string, files: Map<string, any>}} */
const state = { engine: null, store: null, dirHandle: null, root: '', files: new Map() };

let toastTimer = 0;
/** @param {string} msg @param {boolean} [isErr] */
function toast(msg, isErr = false) {
  ui.toast.textContent = msg;
  ui.toast.classList.toggle('err', isErr);
  ui.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.add('hidden'), 3200);
}

// ---------- эмбеддер ----------

/**
 * Загружает Transformers.js из CDN при первом использовании.
 * В WebView и расширении он кладётся локально — см. android/assets.
 * @returns {Promise<import('../core/engine.mjs').Embedder>}
 */
async function loadEmbedder() {
  ui.progressText.textContent = 'загрузка модели (один раз, ~113 МБ)...';
  ui.progress.classList.remove('hidden');
  // В APK библиотека лежит в assets (офлайн), в браузере — с CDN.
  const { pipeline, env } = await import(
    hasNative()
      ? './vendor/transformers.js'
      : 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2'
  );
  env.allowLocalModels = false;
  // В браузере воркеры работают, и numThreads даёт реальное ускорение —
  // в отличие от Node, где пришлось ставить 1 (blob: не грузится).
  env.backends.onnx.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);

  const extractor = await pipeline(
    'feature-extraction', 'Xenova/multilingual-e5-small', { quantized: true },
  );
  ui.progress.classList.add('hidden');

  return {
    dim: 384,
    async embed(texts) {
      if (texts.length === 0) return [];
      const out = await extractor(texts, { pooling: 'mean', normalize: true });
      const dim = out.dims[out.dims.length - 1] ?? 384;
      /** @type {Float32Array[]} */
      const vecs = [];
      for (let i = 0; i < texts.length; i++) {
        vecs.push(Float32Array.from(out.data.slice(i * dim, (i + 1) * dim)));
      }
      return vecs;
    },
  };
}

// ---------- доступ к файлам ----------

/**
 * Обход каталога через File System Access API.
 * @param {any} dirHandle
 * @param {string} [prefix]
 * @returns {Promise<Map<string, {file: File, path: string}>>}
 */
async function walkDir(dirHandle, prefix = '') {
  /** @type {Map<string, {file: File, path: string}>} */
  const out = new Map();
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith('.')) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      if (['node_modules', 'build', 'dist'].includes(name)) continue;
      for (const [k, v] of await walkDir(handle, path)) out.set(k, v);
    } else {
      out.set(path, { file: await handle.getFile(), path });
    }
  }
  return out;
}

/**
 * Строит ФС-снимок по списку файлов.
 * @param {Map<string, {file: File, path: string}>} found
 */
async function buildSnapshot(found) {
  /** @type {Map<string, any>} */
  const files = new Map();
  /** @type {Array<{path: string, why: string}>} */
  const skipped = [];

  for (const [path, { file }] of found) {
    if (file.size === 0) { skipped.push({ path, why: 'пустой' }); continue; }
    if (file.size > 64 * 1024 * 1024) { skipped.push({ path, why: 'больше 64 МБ' }); continue; }

    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    const format = detect(path, head);
    if (!isSupported(format)) { skipped.push({ path, why: `формат ${format}` }); continue; }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await hashBytes(crypto.subtle, bytes);
    const e = entry(path, hash, file.size, Math.floor(file.lastModified));
    e.format = format;
    e.parserVersion = parserVersionFor(format);
    files.set(path, e);
  }
  return { files, skipped };
}

/**
 * @param {Map<string, {file: File, path: string}>} found
 * @returns {(path: string) => Promise<string>}
 */
function makeReader(found) {
  return async (path) => {
    const rec = found.get(path);
    if (!rec) throw new Error(`файл исчез: ${path}`);
    const bytes = new Uint8Array(await rec.file.arrayBuffer());
    const format = detect(path, bytes.subarray(0, 64));
    const info = formatInfo(format);
    if (info.kind === 'text') return new TextDecoder('utf-8').decode(bytes);
    if (info.kind === 'pdf') {
      const { extractPdfText, looksEmpty } = await import('./pdf-web.js');
      // 🔴 AWAIT ОБЯЗАТЕЛЕН: браузерная версия извлечения асинхронна
      // (DecompressionStream), и без await в text попадал Promise.
      // String(Promise) = '[object Promise]' — ровно 15 символов, что
      // короче порога looksEmpty, поэтому КАЖДЫЙ PDF отвергался как
      // «скан без текстового слоя». Отказ молчаливый: сообщение звучало
      // правдоподобно, и дефект выглядел как ограничение формата.
      const text = await extractPdfText(bytes);
      if (looksEmpty(text)) {
        throw new Error(
          `${path}: в PDF нет текстового слоя (похоже на скан). `
          + `Распознавание картинок доступно в десктопной версии.`,
        );
      }
      return text;
    }

    if (info.kind === 'image') {
      // Распознать текст на картинке в браузере нечем: tesseract — это
      // системная утилита, а tesseract.js потянул бы 5 МБ WASM плюс
      // языковые модели по 2-15 МБ каждая. Отказываем ЧЕСТНО, с
      // указанием, где это работает, вместо молчаливого пропуска.
      throw new Error(
        `${path}: распознавание текста на изображениях доступно только `
        + `в десктопной версии (нужен tesseract)`,
      );
    }

    if (info.kind === 'audio' || info.kind === 'video') {
      throw new Error(
        `${path}: расшифровка аудио и видео доступна только в десктопной `
        + `версии (нужен ffmpeg)`,
      );
    }

    throw new Error(`${path}: формат ${format} не поддерживается`);
  };
}

// ---------- сохранение ----------

async function persist() {
  if (!state.store || !state.engine) return;
  const e = state.engine;
  await state.store.saveVectors(e.vectors.serialize());
  await state.store.putChunks([...e.chunks.values()]);
  for (const f of e.files.values()) await state.store.putFile(f);
}

async function restore() {
  if (!state.store || !state.engine) return false;
  const e = state.engine;
  const files = await state.store.allFiles();
  if (files.size === 0) return false;
  for (const [p, f] of files) e.files.set(p, f);
  const v = await state.store.loadVectors();
  if (v) e.vectors = VectorStore.deserialize(v);
  for (const id of e.vectors.ids) {
    const [chunk] = await state.store.getChunks([id]);
    if (chunk) {
      e.chunks.set(chunk.id, chunk);
      e.bm25.add(chunk.id, chunk.text);
    }
  }
  return true;
}

// ---------- история поисков ----------

/**
 * Запись истории в IndexedDB.
 *
 * В бинаре история пишется файлами в searches/, но в браузере доступ к
 * папке даётся ТОЛЬКО НА ЧТЕНИЕ (showDirectoryPicker mode:'read'), и
 * писать рядом с документами нельзя без отдельного разрешения.
 * localStorage не подходит: лимит ~5 МБ и только строки, а цитаты
 * бывают длинными.
 *
 * Формат совпадает с файловым: { "<промпт>": { "<путь>": "<текст>" } } —
 * чтобы историю можно было выгрузить и сравнить с бинарём.
 */
async function saveSearchHistory(prompt, citations) {
  if (!state.store) return;
  const now = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ts = [
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`,
    `${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`,
    p(now.getMilliseconds(), 3),
  ].join('---');

  const byPath = {};
  for (const c of citations) {
    const key = sourceLabel(c.chunk);
    // Несколько фрагментов одного файла склеиваются, сохраняя порядок
    // ранжирования, иначе часть результатов потерялась бы
    byPath[key] = byPath[key] ? `${byPath[key]}\n\n---\n\n${c.chunk.text}` : c.chunk.text;
  }

  try {
    await state.store.setMeta(`search:${ts}`, { [prompt]: byPath });
  } catch (e) {
    // История — вспомогательная вещь: её отказ не должен ломать поиск
    console.warn('история не сохранена:', e);
  }
}

/** Выгрузка истории: для сверки с бинарём и анализа. */
async function exportHistory() {
  if (!state.store) return [];
  return state.store.listMeta('search:');
}

// ---------- интерфейс ----------

/**
 * Включает кнопки шапки.
 *
 * Отключены до появления движка: нажатие «проиндексировать» без
 * выбранной папки не имеет смысла, а отключённая кнопка объясняет это
 * лучше, чем сообщение об ошибке после клика.
 */
function syncTopButtons() {
  const ready = state.engine !== null;
  ui.indexTop.disabled = !ready;
  ui.resetTop.disabled = !ready;
}

function refreshStats() {
  const e = state.engine;
  if (!e) return;
  ui.statFiles.textContent = String(e.fileCount);
  ui.statChunks.textContent = String(e.chunkCount);
  ui.statDir.textContent = state.root;
  ui.status.classList.remove('hidden');
  // Панель поиска появляется только когда есть что искать
  ui.searchRoot.classList.toggle('hidden', e.chunkCount === 0);
  ui.setup.classList.add('hidden');
  syncTopButtons();
  mountSearchOnce();
}

/** React монтируется один раз: повторный createRoot на том же узле — ошибка. */
let searchUi = null;
function mountSearchOnce() {
  if (searchUi) return;
  searchUi = mountSearch(ui.searchRoot, {
    async onSearch(query, opts) {
      const e = state.engine;
      if (!e) throw new Error('движок не готов');
      return e.search(query, {
        k: 5,
        expand: opts.expand,
        mode: opts.mode,
      }).then(async (r) => {
        await saveSearchHistory(query, r.citations);
        return r;
      });
    },
  });
}




// ---------- действия ----------

/** Есть ли Android-мост (APK-сборка). */
const hasNative = () => typeof (/** @type {any} */ (window).Native) !== 'undefined';

/**
 * Файлы из Android SAF. В WebView нет File System Access API, поэтому
 * дерево обходится нативно, а содержимое приходит base64 через мост —
 * JS-интерфейс Android не умеет передавать бинарные данные.
 * @returns {Promise<Map<string, {file: File, path: string}>>}
 */
async function nativeFiles() {
  const N = /** @type {any} */ (window).Native;
  /** @type {Array<{path: string, size: number, mtime: number, uri: string}>} */
  const list = JSON.parse(N.listFiles());
  /** @type {Map<string, {file: File, path: string}>} */
  const out = new Map();
  for (const it of list) {
    const b64 = N.readFile(it.uri);
    if (!b64) continue;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], it.path.split('/').pop() ?? it.path, {
      lastModified: it.mtime,
    });
    out.set(it.path, { file, path: it.path });
  }
  return out;
}

async function pickFolder() {
  if (hasNative()) {
    /** @type {any} */ (window).Native.pickFolder();
    return; // продолжение в window.__onFolderPicked
  }
  if (!('showDirectoryPicker' in window)) {
    ui.fallbackNote.classList.remove('hidden');
    toast('Выбор папки недоступен — добавьте файлы', true);
    return;
  }
  try {
    state.dirHandle = await /** @type {any} */ (window).showDirectoryPicker({ mode: 'read' });
  } catch {
    return; // пользователь отменил
  }
  state.root = state.dirHandle.name;
  await initEngine();
  toast(`папка: ${state.root}`);
  await runIndex();
}

async function initEngine() {
  if (state.engine) return;
  const embedder = await loadEmbedder();
  state.engine = new Engine({ embedder });
  state.store = await Store.open(indexedDB);
  await restore();
  refreshStats();
}

async function runIndex() {
  const e = state.engine;
  if (!e) { toast('сначала выберите папку', true); return; }

  ui.index.disabled = true;
  ui.progress.classList.remove('hidden');
  try {
    const found = hasNative()
      ? await nativeFiles()
      : state.dirHandle
        ? await walkDir(state.dirHandle)
        : state.files;
    const { files, skipped } = await buildSnapshot(found);

    const res = await e.sync(files, makeReader(found), (p) => {
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      ui.bar.style.width = `${pct}%`;
      const name = p.file ? p.file.split('/').pop() : '';
      ui.progressText.textContent =
        p.phase === 'embed' ? `${name}: ${p.done}/${p.total}` :
        p.phase === 'read' ? `чтение ${name}` : 'готово';
    });

    await persist();
    refreshStats();
    ui.diff.textContent = res.summary +
      (skipped.length ? ` · пропущено ${skipped.length}` : '');
    toast('индекс обновлён');
  } catch (err) {
    toast(String(
async function runReset() {
  if (!state.store) return;
  await state.store.clear();
  state.engine = null;
  state.files.clear();
  searchUi?.clear();
  ui.diff.textContent = '';
  ui.status.classList.add('hidden');
  ui.searchRoot.classList.add('hidden');
  ui.setup.classList.remove('hidden');
  syncTopButtons();
  toast('индекс сброшен');
}

// ---------- события ----------

ui.pick.addEventListener('click', pickFolder);
ui.folder.addEventListener('click', pickFolder);
ui.index.addEventListener('click', runIndex);
ui.reset.addEventListener('click', runReset);
// Те же действия из шапки: доступны, не прокручивая страницу
ui.indexTop.addEventListener('click', runIndex);
ui.resetTop.addEventListener('click', runReset);
ui.files.addEventListener('click', () => ui.fileInput.click());
ui.fileInput.addEventListener('change', async () => {
  const list = /** @type {FileList} */ (ui.fileInput.files);
  state.files = new Map(
    [...list].map((f) => [f.name, { file: f, path: f.name }]),
  );
  state.root = `${list.length} файлов`;
  await initEngine();
  await runIndex();
});

// Вызывается из MainActivity после выбора папки в системном SAF
/** @type {any} */ (window).__onFolderPicked = async () => {
  state.root = 'выбранная папка';
  await initEngine();
  await runIndex();
};

// Аппаратная кнопка Back: true = мы что-то закрыли, false = выходим
/** @type {any} */ (window).__onBack = () => {
  if (ui.results.innerHTML !== '') {
    ui.results.innerHTML = '';
    ui.q.value = '';
    return true;
  }
  return false;
};

if (!('showDirectoryPicker' in window) && !hasNative()) {
  ui.fallbackNote.classList.remove('hidden');
}
