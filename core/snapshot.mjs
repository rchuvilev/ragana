// ФС-снимок: структура дерева + хэш содержимого каждого файла.
//
// ПОЧЕМУ ХЭШ, А НЕ mtime+size (замена прежнего подхода):
//   1. Android SAF/MTP и многие файловые менеджеры СОХРАНЯЮТ mtime исходника
//      при копировании, так что отредактированный файл приезжает со старым
//      временем — правка не попала бы в переиндексацию никогда.
//   2. Chrome-расширение через File System Access API отдаёт lastModified,
//      который для некоторых источников просто равен времени ЧТЕНИЯ.
//   3. Перемещение/переименование по mtime выглядит как «удалили и создали»
//      => повторный эмбеддинг всего файла. По хэшу это бесплатный rename.
//
// ЦЕНА ИЗМЕРЕНА (test/hashbench.mjs, этот Snapdragon 732G):
//   WebCrypto SHA-256 = 698 МБ/с; 1 ГБ документов = 1.4 с.
// Эмбеддинг ОДНОГО чанка — 438 мс. То есть хэширование гигабайта стоит
// меньше, чем 4 чанка. Предфильтр по mtime для КОРРЕКТНОСТИ не нужен,
// он оставлен только как необязательный ускоритель (см. fastSkip).

/**
 * Хэш содержимого. Возвращает hex-строку.
 *
 * Тип subtle задан СТРУКТУРНО, а не как DOM-ный SubtleCrypto: в Node это
 * webcrypto.subtle, в браузере — crypto.subtle, и их номинальные типы
 * не совпадают, хотя оба умеют digest(). Ядро обязано работать в обоих.
 *
 * @param {{digest: (alg: string, data: any) => Promise<ArrayBuffer>}} subtle
 * @param {ArrayBufferView | ArrayBuffer} bytes
 * @returns {Promise<string>}
 */
export async function hashBytes(subtle, bytes) {
  const digest = await subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += (view[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Запись о файле в снимке.
 * mtime/size хранятся НЕ для сравнения, а чтобы дать fastSkip шанс
 * пропустить хэширование заведомо нетронутых файлов.
 *
 * @param {string} path
 * @param {string} hash
 * @param {number} size
 * @param {number} [mtime]
 * @returns {import('../types/index.js').FileEntry}
 */
export function entry(path, hash, size, mtime = 0) {
  return { path, hash, size, mtime };
}

/**
 * Можно ли пропустить перечитывание файла.
 *
 * Применимо ТОЛЬКО когда mtime И size совпадают: тогда файл почти наверняка
 * не менялся, и мы переиспользуем старый хэш. Если mtime недостоверен
 * (то есть изменился зря), мы просто пересчитаем хэш и увидим, что он
 * прежний — лишняя работа, но НЕ потеря изменения. Асимметрия намеренная:
 * ошибка в сторону «перепроверить» безопасна, в сторону «пропустить» — нет.
 *
 * @param {{size: number, mtime: number}} now
 * @param {{hash?: string, size: number, mtime: number} | null | undefined} prev
 * @returns {boolean}
 */
export function fastSkip(now, prev) {
  return (
    prev != null &&
    prev.hash != null &&
    now.size === prev.size &&
    now.mtime !== 0 &&
    now.mtime === prev.mtime
  );
}

/**
 * Сравнение двух снимков. Ключ сравнения — ХЭШ, а не время.
 *
 * Отдельно выделены renamed: содержимое уже проиндексировано, нужно лишь
 * переписать путь у существующих чанков — без повторного эмбеддинга.
 *
 * @param {Map<string, {hash: string, size: number}>} now
 * @param {Map<string, {hash: string, size: number}>} prev
 * @returns {import('../types/index.js').SnapshotDiff}
 */
export function diffSnapshots(now, prev) {
  /** @type {string[]} */ const added = [];
  /** @type {string[]} */ const changed = [];
  /** @type {string[]} */ const removed = [];
  /** @type {string[]} */ const same = [];
  /** @type {import('../types/index.js').Rename[]} */ const renamed = [];

  for (const [path, cur] of now) {
    const old = prev.get(path);
    if (!old) added.push(path);
    else if (old.hash !== cur.hash) changed.push(path);
    else same.push(path);
  }
  for (const path of prev.keys()) {
    if (!now.has(path)) removed.push(path);
  }

  // Переименование: исчезнувший путь и появившийся с ТЕМ ЖЕ хэшем.
  // Хэш -> СПИСОК исчезнувших путей, чтобы несколько одинаковых файлов
  // не схлопнулись в одно сопоставление (дубликаты в папке — норма).
  /** @type {Map<string, string[]>} */
  const goneByHash = new Map();
  for (const path of removed) {
    const old = prev.get(path);
    if (!old) continue;
    const pool = goneByHash.get(old.hash);
    if (pool) pool.push(path);
    else goneByHash.set(old.hash, [path]);
  }

  /** @type {string[]} */
  const stillAdded = [];
  for (const path of added) {
    const cur = now.get(path);
    const pool = cur ? goneByHash.get(cur.hash) : undefined;
    const from = pool && pool.length ? pool.shift() : undefined;
    if (cur && from !== undefined) {
      renamed.push({ from, to: path, hash: cur.hash });
    } else {
      stillAdded.push(path);
    }
  }
  const renamedFrom = new Set(renamed.map((r) => r.from));

  return {
    added: stillAdded,
    changed,
    removed: removed.filter((p) => !renamedFrom.has(p)),
    renamed,
    same,
  };
}

/**
 * @param {import('../types/index.js').SnapshotDiff} d
 * @returns {boolean}
 */
export function hasWork(d) {
  return (
    d.added.length + d.changed.length + d.removed.length + d.renamed.length > 0
  );
}

/**
 * Старые чанки, подлежащие удалению (изменённые + удалённые, НЕ переименованные).
 * @param {import('../types/index.js').SnapshotDiff} d
 * @returns {string[]}
 */
export function pathsToPurge(d) {
  return [...d.changed, ...d.removed];
}

/**
 * Файлы, требующие чтения и эмбеддинга.
 * @param {import('../types/index.js').SnapshotDiff} d
 * @returns {string[]}
 */
export function pathsToIngest(d) {
  return [...d.added, ...d.changed];
}

/**
 * @param {import('../types/index.js').SnapshotDiff} d
 * @returns {string}
 */
export function describe(d) {
  if (!hasWork(d)) return `актуально: ${d.same.length} файлов`;
  const p = [];
  if (d.added.length) p.push(`новых ${d.added.length}`);
  if (d.changed.length) p.push(`изменённых ${d.changed.length}`);
  if (d.renamed.length) p.push(`перемещённых ${d.renamed.length}`);
  if (d.removed.length) p.push(`удалённых ${d.removed.length}`);
  return `${p.join(', ')} (без изменений ${d.same.length})`;
}
