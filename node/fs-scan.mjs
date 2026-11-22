// Сканер файловой системы для Node/CLI: строит ФС-снимок с хэшами.
//
// Хэшируется содержимое, не mtime — см. core/snapshot.mjs. Цена измерена:
// WebCrypto 698 МБ/с на этом телефоне, 1 ГБ = 1.4 с, что дешевле четырёх
// эмбеддингов. fastSkip переиспользует прошлый хэш, когда mtime И размер
// совпали, но это ускоритель, а не условие корректности.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { webcrypto } from 'node:crypto';
import { hashBytes, entry, fastSkip } from '../core/snapshot.mjs';
import { detect, isSupported, parserVersionFor, formatInfo } from '../core/formats.mjs';

/** Каталоги, которые никогда не индексируются. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__',
  '.cache', '.thumbnails', '.trash', 'build', 'dist',
]);

/**
 * Рекурсивный обход каталога.
 *
 * @param {string} root
 * @param {object} [opts]
 * @param {number} [opts.maxBytes] пропускать файлы больше (по умолчанию 64 МБ)
 * @param {Map<string, import('../types/index.js').FileEntry>} [opts.prev] прошлый снимок для fastSkip
 * @param {(path: string) => void} [opts.onFile]
 * @returns {Promise<{files: Map<string, import('../types/index.js').FileEntry>, skipped: Array<{path: string, why: string}>}>}
 */
export async function scanDir(root, opts = {}) {
  const { maxBytes = 64 * 1024 * 1024, prev, onFile } = opts;
  /** @type {Map<string, import('../types/index.js').FileEntry>} */
  const files = new Map();
  /** @type {Array<{path: string, why: string}>} */
  const skipped = [];

  /** @param {string} dir */
  async function walk(dir) {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      skipped.push({ path: dir, why: `не читается: ${String(e)}` });
      return;
    }
    for (const d of entries) {
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name) || d.name.startsWith('.')) continue;
        await walk(full);
        continue;
      }
      if (!d.isFile()) continue;
      if (d.name.startsWith('.')) continue;

      const rel = relative(root, full).split(sep).join('/');
      let st;
      try {
        st = await stat(full);
      } catch (e) {
        skipped.push({ path: rel, why: 'нет доступа' });
        continue;
      }
      if (st.size > maxBytes) {
        skipped.push({ path: rel, why: `слишком большой (${(st.size / 1048576).toFixed(1)} МБ)` });
        continue;
      }
      if (st.size === 0) {
        skipped.push({ path: rel, why: 'пустой' });
        continue;
      }

      const mtime = Math.floor(st.mtimeMs);
      const old = prev?.get(rel);

      // Быстрый путь: mtime и размер совпали — переиспользуем хэш.
      // Ошибка в сторону «перепроверить» безопасна, в сторону «пропустить» нет.
      if (old && fastSkip({ size: st.size, mtime }, old)) {
        files.set(rel, old);
        onFile?.(rel);
        continue;
      }

      let bytes;
      try {
        bytes = await readFile(full);
      } catch {
        skipped.push({ path: rel, why: 'нет доступа' });
        continue;
      }

      const head = bytes.subarray(0, 64);
      const format = detect(rel, head);
      if (!isSupported(format)) {
        skipped.push({ path: rel, why: `формат ${format} не поддерживается` });
        continue;
      }

      const hash = await hashBytes(webcrypto.subtle, new Uint8Array(bytes));
      const e = entry(rel, hash, st.size, mtime);
      e.format = format;
      e.parserVersion = parserVersionFor(format);
      files.set(rel, e);
      onFile?.(rel);
    }
  }

  await walk(root);
  return { files, skipped };
}

/**
 * Извлечение текста из файла.
 *
 * PDF и изображения требуют отдельных парсеров: PDF — текстового слоя,
 * изображения — OCR. Пока они не подключены, функция честно сообщает
 * об этом, а не возвращает пустую строку: молчаливо пустой документ
 * выглядел бы как успешно проиндексированный.
 *
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<string>}
 */
export async function readDocument(root, rel) {
  const full = join(root, rel);
  const bytes = await readFile(full);
  const format = detect(rel, bytes.subarray(0, 64));
  const info = formatInfo(format);

  if (info.kind === 'text') {
    return bytes.toString('utf8');
  }
  if (info.kind === 'pdf') {
    const { extractPdfText } = await import('./pdf.mjs');
    return extractPdfText(new Uint8Array(bytes));
  }
  throw new Error(
    `${rel}: формат ${format} требует ${info.ocr === true ? 'OCR' : 'парсера'}, ` +
    `который ещё не подключён`,
  );
}
