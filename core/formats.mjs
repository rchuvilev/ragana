// Реестр форматов: какой парсер отвечает за расширение, и КАКОЙ ОН ВЕРСИИ.
//
// Версия — не косметика. Когда парсер PDF улучшается, содержимое файлов
// не меняется => хэши прежние => diff скажет «работы нет», и индекс навсегда
// останется построенным старой, худшей версией. Поэтому условие устаревания:
//     хэш изменился  ИЛИ  parserVersion вырос
// Это и есть причина, по которой реестр лежит отдельной таблицей, а версия
// парсера пишется в запись о файле.
//
// Определение формата идёт по СОДЕРЖИМОМУ (magic bytes), а расширение —
// лишь подсказка: на Android файлы приезжают как `document(1)` без
// расширения, а `.txt` сплошь и рядом оказывается PDF-ом.

/**
 * Сигнатуры: [смещение, байты, формат]. Порядок = приоритет.
 * @type {ReadonlyArray<readonly [number, readonly number[], import('../types/index.js').Format]>}
 */
const MAGIC = /** @type {const} */ ([
  [0, [0x25, 0x50, 0x44, 0x46], 'pdf'],          // %PDF
  [0, [0xff, 0xd8, 0xff], 'jpeg'],
  [0, [0x89, 0x50, 0x4e, 0x47], 'png'],
  [0, [0x47, 0x49, 0x46, 0x38], 'gif'],
  [0, [0x42, 0x4d], 'bmp'],
  [0, [0x50, 0x4b, 0x03, 0x04], 'zip'],          // docx/xlsx/epub тоже
  [8, [0x57, 0x45, 0x42, 0x50], 'webp'],         // RIFF....WEBP
  [4, [0x66, 0x74, 0x79, 0x70], 'heic'],         // ....ftyp
]);

/**
 * Формат по первым байтам. null если не опознан.
 * @param {Uint8Array} bytes
 * @returns {import('../types/index.js').Format | null}
 */
export function sniff(bytes) {
  for (const [off, sig, fmt] of MAGIC) {
    if (bytes.length < off + sig.length) continue;
    let ok = true;
    for (let i = 0; i < sig.length; i++) {
      if (bytes[off + i] !== sig[i]) { ok = false; break; }
    }
    if (ok) return fmt;
  }
  return null;
}

/**
 * Расширение в нижнем регистре без точки, либо ''.
 * @param {string} path
 * @returns {string}
 */
export function extOf(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** @type {Record<string, import('../types/index.js').Format>} */
const EXT_MAP = {
  txt: 'text', md: 'text', markdown: 'text', csv: 'text', log: 'text',
  json: 'text', xml: 'text', html: 'text', htm: 'text', rtf: 'text',
  pdf: 'pdf',
  jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', bmp: 'bmp',
  webp: 'webp', heic: 'heic', heif: 'heic', tif: 'tiff', tiff: 'tiff',
  docx: 'zip', epub: 'zip',
};

/**
 * Итоговый формат. Содержимое ПЕРЕВЕШИВАЕТ расширение, потому что
 * расширение подделывается и теряется, а magic bytes — нет.
 * Текст не имеет сигнатуры, поэтому распознаётся отдельно.
 * @param {string} path
 * @param {Uint8Array | null | undefined} bytes
 * @returns {import('../types/index.js').Format}
 */
export function detect(path, bytes) {
  const sniffed = bytes ? sniff(bytes) : null;
  if (sniffed) return sniffed;
  const byExt = EXT_MAP[extOf(path)];
  if (bytes && looksLikeText(bytes)) return 'text';
  return byExt || 'unknown';
}

/**
 * Эвристика «это текст»: нет нулевых байтов и мало управляющих символов
 * в первом килобайте. UTF-8 с кириллицей проходит, бинарь — нет.
 * @param {Uint8Array} bytes
 * @param {number} [probe]
 * @returns {boolean}
 */
export function looksLikeText(bytes, probe = 1024) {
  const n = Math.min(bytes.length, probe);
  if (n === 0) return true; // пустой файл — безвредный текст
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === undefined || b === 0) return false;
    const printable = b === 9 || b === 10 || b === 13 || b >= 32;
    if (!printable) ctrl++;
  }
  return ctrl / n < 0.05;
}

/** Группы: как файл вообще превращается в текст. */
/** @type {Record<import('../types/index.js').Kind, import('../types/index.js').Kind>} */
export const KIND = {
  text: 'text',     // читается напрямую
  pdf: 'pdf',       // слой текста, иначе OCR постранично
  image: 'image',   // только OCR
  archive: 'archive',
  unknown: 'unknown',
};

/**
 * Реестр. parserVersion поднимается РУКАМИ при изменении парсера —
 * это и запускает переиндексацию только затронутых файлов.
 * @type {Record<import('../types/index.js').Format, import('../types/index.js').FormatInfo>}
 */
export const REGISTRY = {
  text:  { kind: KIND.text,    parser: 'plain',  parserVersion: 1, ocr: false },
  pdf:   { kind: KIND.pdf,     parser: 'pdf',    parserVersion: 1, ocr: 'fallback' },
  jpeg:  { kind: KIND.image,   parser: 'image',  parserVersion: 1, ocr: true },
  png:   { kind: KIND.image,   parser: 'image',  parserVersion: 1, ocr: true },
  gif:   { kind: KIND.image,   parser: 'image',  parserVersion: 1, ocr: true },
  bmp:   { kind: KIND.image,   parser: 'image',  parserVersion: 1, ocr: true },
  webp:  { kind: KIND.image,   parser: 'image',  parserVersion: 1, ocr: true },
  heic:  { kind: KIND.image,   parser: 'image',  parserVersion: 1, ocr: true },
  tiff:  { kind: KIND.image,   parser: 'image',  parserVersion: 1, ocr: true },
  zip:   { kind: KIND.archive, parser: null,     parserVersion: 0, ocr: false },
  unknown: { kind: KIND.unknown, parser: null,   parserVersion: 0, ocr: false },
};

/**
 * @param {string} fmt
 * @returns {import('../types/index.js').FormatInfo}
 */
export function formatInfo(fmt) {
  return REGISTRY[/** @type {import('../types/index.js').Format} */ (fmt)]
    || REGISTRY.unknown;
}

/**
 * Поддерживается ли формат вообще.
 * @param {string} fmt
 * @returns {boolean}
 */
export function isSupported(fmt) {
  return formatInfo(fmt).parser !== null;
}

/**
 * Версия парсера для файла — входит в условие переиндексации
 * наравне с хэшем содержимого.
 * @param {string} fmt
 * @returns {number}
 */
export function parserVersionFor(fmt) {
  return formatInfo(fmt).parserVersion;
}

/**
 * Устарел ли разбор файла.
 * Два независимых повода: другое содержимое ЛИБО более новый парсер.
 * @param {{hash: string, format: string}} now
 * @param {{hash: string, parserVersion?: number} | null | undefined} prev
 * @returns {boolean}
 */
export function needsReparse(now, prev) {
  if (!prev) return true;
  if (now.hash !== prev.hash) return true;
  return parserVersionFor(now.format) > (prev.parserVersion || 0);
}
