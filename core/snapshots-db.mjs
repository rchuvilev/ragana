// Хранилище ФС-снимков по таймстемпу.
//
// ПОЧЕМУ ОТДЕЛЬНАЯ ТАБЛИЦА, НО НЕ ОТДЕЛЬНАЯ БД:
// IndexedDB не умеет транзакцию поверх ДВУХ баз. Если снимки живут в своей
// базе, то «снимок записан» и «индекс обновлён» не могут быть атомарны:
// процесс убит между ними (на Android — обычное дело, WebView выгружают
// в фоне) => снимок утверждает, что файлы проиндексированы, а чанков нет.
// Индекс тихо испорчен и чинится только полной пересборкой.
// Один store в общей БД => обе записи идут одной транзакцией.
//
// Снимок хранится как ОДНА запись со всем списком файлов, а не строка на
// файл: снимок читается и пишется всегда целиком, а 5000 put() на телефоне
// стоят секунды против миллисекунд на один объект.

export const SNAPSHOTS = 'snapshots';

/**
 * Структура снимка. files: Map -> простой объект для structured clone.
 * @param {string} root
 * @param {Map<string, import('../types/index.js').FileEntry>} filesMap
 * @param {{ts?: number, note?: string}} [opts]
 * @returns {import('../types/index.js').Snapshot}
 */
export function makeSnapshot(root, filesMap, { ts = Date.now(), note = '' } = {}) {
  /** @type {Record<string, import('../types/index.js').SnapshotFile>} */
  const files = {};
  let bytes = 0;
  for (const [path, e] of filesMap) {
    files[path] = {
      hash: e.hash,
      size: e.size,
      mtime: e.mtime || 0,
      format: e.format || 'unknown',
      parserVersion: e.parserVersion || 0,
    };
    bytes += e.size || 0;
  }
  return { ts, root, note, count: filesMap.size, bytes, files };
}

/**
 * Обратно в Map для diffSnapshots.
 * @param {import('../types/index.js').Snapshot | null | undefined} snap
 * @returns {Map<string, import('../types/index.js').FileEntry>}
 */
export function snapshotToMap(snap) {
  /** @type {Map<string, import('../types/index.js').FileEntry>} */
  const m = new Map();
  if (!snap) return m;
  for (const [path, e] of Object.entries(snap.files)) {
    m.set(path, { path, ...e });
  }
  return m;
}

// ЗАПРОС и ТРАНЗАКЦИЯ завершаются РАЗНЫМИ событиями: у IDBRequest это
// onsuccess, у IDBTransaction — oncomplete. Один общий promisify(tx)
// вешался навсегда (onsuccess у транзакции не наступает никогда), и
// node:test сообщал об этом как 'Promise resolution is still pending',
// печатая при этом '# fail 0'. Поэтому две отдельные функции.
/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
const promisify = (req) =>
  new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

/**
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
const txDone = (tx) =>
  new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('транзакция отменена'));
  });

export class SnapshotLog {
  /** @param {IDBDatabase} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * Вызывается из onupgradeneeded общей БД.
   * @param {IDBDatabase} db
   */
  static upgrade(db) {
    if (!db.objectStoreNames.contains(SNAPSHOTS)) {
      const s = db.createObjectStore(SNAPSHOTS, { keyPath: 'ts' });
      s.createIndex('byRoot', 'root', { unique: false });
    }
  }

  /**
   * @param {import('../types/index.js').Snapshot} snap
   * @returns {Promise<number>}
   */
  async put(snap) {
    const tx = this.db.transaction([SNAPSHOTS], 'readwrite');
    await promisify(tx.objectStore(SNAPSHOTS).put(snap));
    return snap.ts;
  }

  /**
   * Самый свежий снимок для корня, либо null.
   * @param {string} root
   * @returns {Promise<import('../types/index.js').Snapshot | null>}
   */
  async latest(root) {
    const tx = this.db.transaction([SNAPSHOTS], 'readonly');
    const idx = tx.objectStore(SNAPSHOTS).index('byRoot');
    /** @type {import('../types/index.js').Snapshot[]} */
    const all = await promisify(idx.getAll(IDBKeyRange.only(root)));
    if (!all.length) return null;
    return all.reduce((a, b) => (b.ts > a.ts ? b : a));
  }

  /**
   * @param {number} ts
   * @returns {Promise<import('../types/index.js').Snapshot | undefined>}
   */
  async get(ts) {
    const tx = this.db.transaction([SNAPSHOTS], 'readonly');
    return promisify(tx.objectStore(SNAPSHOTS).get(ts));
  }

  /**
   * История без тяжёлого files — для списка в интерфейсе.
   * @param {string} root
   * @param {number} [limit]
   * @returns {Promise<import('../types/index.js').SnapshotMeta[]>}
   */
  async history(root, limit = 20) {
    const tx = this.db.transaction([SNAPSHOTS], 'readonly');
    const idx = tx.objectStore(SNAPSHOTS).index('byRoot');
    /** @type {import('../types/index.js').Snapshot[]} */
    const all = await promisify(idx.getAll(IDBKeyRange.only(root)));
    return all
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
      .map(({ ts, root: r, note, count, bytes }) => ({ ts, root: r, note, count, bytes }));
  }

  /**
   * Оставить N последних снимков корня. Снимки нужны для diff и разбора
   * «что поменялось вчера», но неограниченная история — это утечка:
   * каждый снимок весит ~100 байт на файл.
   *
   * @param {string} root
   * @param {number} [keep]
   * @returns {Promise<number>} сколько удалено
   */
  async prune(root, keep = 10) {
    const tx = this.db.transaction([SNAPSHOTS], 'readwrite');
    const store = tx.objectStore(SNAPSHOTS);
    /** @type {import('../types/index.js').Snapshot[]} */
    const all = await promisify(store.index('byRoot').getAll(IDBKeyRange.only(root)));
    const doomed = all.sort((a, b) => b.ts - a.ts).slice(keep);
    for (const s of doomed) store.delete(s.ts);
    await txDone(tx);
    return doomed.length;
  }

  /**
   * @param {string | null} [root]
   * @returns {Promise<void>}
   */
  async clear(root = null) {
    const tx = this.db.transaction([SNAPSHOTS], 'readwrite');
    const store = tx.objectStore(SNAPSHOTS);
    if (root == null) {
      store.clear();
    } else {
      /** @type {import('../types/index.js').Snapshot[]} */
      const all = await promisify(store.index('byRoot').getAll(IDBKeyRange.only(root)));
      for (const s of all) store.delete(s.ts);
    }
    await txDone(tx);
  }
}
