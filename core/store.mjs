// Персистентность поверх IndexedDB — единственного хранилища, доступного
// ОДИНАКОВО в Android WebView, в service worker MV3-расширения и (через
// полифил) в Node. OPFS отпал именно потому, что в расширении его нет.
//
// ОДНА база, несколько store — не несколько баз: IndexedDB не умеет
// транзакцию поверх двух баз, поэтому «снимок записан» и «чанки обновлены»
// не были бы атомарны. Убитый в фоне WebView (на Android — норма) оставил бы
// снимок, утверждающий, что файлы проиндексированы, при отсутствии чанков.
//
// Схема:
//   files     — путь -> хэш, размер, формат, версия парсера, число чанков
//   chunks    — текст фрагмента + координаты для цитаты (индекс byPath)
//   snapshots — история состояния дерева по таймстемпу (см. snapshots-db.mjs)
//   meta      — матрица векторов одной записью
//
// Матрица пишется ОДНОЙ записью, а не по вектору на строку: 5000 отдельных
// put() в IndexedDB на телефоне — это секунды, один ArrayBuffer — миллисекунды.

import { SnapshotLog } from './snapshots-db.mjs';

const DB_NAME = 'ragbox';
const DB_VERSION = 1;

/**
 * @param {IDBFactory} factory
 * @param {string} [name]
 * @returns {Promise<IDBDatabase>}
 */
export function openDB(factory, name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'path' });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const s = db.createObjectStore('chunks', { keyPath: 'id' });
        s.createIndex('byPath', 'path', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      SnapshotLog.upgrade(db);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// IDBRequest завершается onsuccess, IDBTransaction — oncomplete.
// Ожидание транзакции через promisify висело бы вечно (дефект найден
// тестом в snapshots-db.mjs и исправлен здесь превентивно).
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

export class Store {
  /** @param {IDBDatabase} db */
  constructor(db) {
    this.db = db;
    this.snapshots = new SnapshotLog(db);
  }

  /**
   * @param {IDBFactory} factory
   * @param {string} [name]
   * @returns {Promise<Store>}
   */
  static async open(factory, name = DB_NAME) {
    return new Store(await openDB(factory, name));
  }

  /**
   * @param {string[]} names
   * @param {IDBTransactionMode} mode
   * @returns {IDBTransaction}
   */
  _tx(names, mode) {
    return this.db.transaction(names, mode);
  }

  /**
   * Все известные файлы.
   * @returns {Promise<Map<string, import('../types/index.js').FileEntry>>}
   */
  async allFiles() {
    const tx = this._tx(['files'], 'readonly');
    /** @type {import('../types/index.js').FileEntry[]} */
    const rows = await promisify(tx.objectStore('files').getAll());
    /** @type {Map<string, import('../types/index.js').FileEntry>} */
    const map = new Map();
    for (const r of rows) map.set(r.path, r);
    return map;
  }

  /**
   * @param {import('../types/index.js').FileEntry} rec
   * @returns {Promise<void>}
   */
  async putFile(rec) {
    const tx = this._tx(['files'], 'readwrite');
    tx.objectStore('files').put(rec);
    await txDone(tx);
  }

  /**
   * Удаляет файл и ВСЕ его чанки одной транзакцией.
   * Частичное удаление оставило бы цитаты из несуществующего документа.
   * @param {string} path
   * @returns {Promise<number>} сколько чанков удалено
   */
  async deleteFile(path) {
    const tx = this._tx(['files', 'chunks'], 'readwrite');
    const chunks = tx.objectStore('chunks');
    const keys = await promisify(
      chunks.index('byPath').getAllKeys(IDBKeyRange.only(path)),
    );
    for (const k of keys) chunks.delete(k);
    tx.objectStore('files').delete(path);
    await txDone(tx);
    return keys.length;
  }

  /**
   * Переименование без переэмбеддинга: у чанков меняется только путь.
   * @param {string} from
   * @param {string} to
   * @returns {Promise<number>} сколько чанков перепривязано
   */
  async renameFile(from, to) {
    const tx = this._tx(['files', 'chunks'], 'readwrite');
    const files = tx.objectStore('files');
    const chunks = tx.objectStore('chunks');
    /** @type {import('../types/index.js').FileEntry | undefined} */
    const rec = await promisify(files.get(from));
    if (!rec) {
      await txDone(tx);
      return 0;
    }
    /** @type {import('../types/index.js').Chunk[]} */
    const list = await promisify(
      chunks.index('byPath').getAll(IDBKeyRange.only(from)),
    );
    for (const c of list) {
      chunks.delete(c.id);
      chunks.put({ ...c, path: to });
    }
    files.delete(from);
    files.put({ ...rec, path: to });
    await txDone(tx);
    return list.length;
  }

  /**
   * @param {import('../types/index.js').Chunk[]} list
   * @returns {Promise<void>}
   */
  async putChunks(list) {
    const tx = this._tx(['chunks'], 'readwrite');
    const s = tx.objectStore('chunks');
    for (const c of list) s.put(c);
    await txDone(tx);
  }

  /**
   * @param {string[]} ids
   * @returns {Promise<Array<import('../types/index.js').Chunk | undefined>>}
   */
  async getChunks(ids) {
    const tx = this._tx(['chunks'], 'readonly');
    const s = tx.objectStore('chunks');
    return Promise.all(ids.map((id) => promisify(s.get(id))));
  }

  /**
   * @param {string} path
   * @returns {Promise<import('../types/index.js').Chunk[]>}
   */
  async chunksOf(path) {
    const tx = this._tx(['chunks'], 'readonly');
    return promisify(
      tx.objectStore('chunks').index('byPath').getAll(IDBKeyRange.only(path)),
    );
  }

  /** @returns {Promise<number>} */
  async countChunks() {
    const tx = this._tx(['chunks'], 'readonly');
    return promisify(tx.objectStore('chunks').count());
  }

  /**
   * Матрица векторов — одной записью.
   * @param {import('../types/index.js').SerializedVectors} serialized
   * @returns {Promise<void>}
   */
  async saveVectors(serialized) {
    const tx = this._tx(['meta'], 'readwrite');
    tx.objectStore('meta').put({ key: 'vectors', value: serialized });
    await txDone(tx);
  }

  /** @returns {Promise<import('../types/index.js').SerializedVectors | null>} */
  async loadVectors() {
    const tx = this._tx(['meta'], 'readonly');
    /** @type {{key: string, value: import('../types/index.js').SerializedVectors} | undefined} */
    const row = await promisify(tx.objectStore('meta').get('vectors'));
    return row ? row.value : null;
  }

  /** @returns {Promise<void>} */
  async clear() {
    const tx = this._tx(['files', 'chunks', 'meta'], 'readwrite');
    tx.objectStore('files').clear();
    tx.objectStore('chunks').clear();
    tx.objectStore('meta').clear();
    await txDone(tx);
  }
}
