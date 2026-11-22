// Персистентность поверх IndexedDB — единственного хранилища, доступного
// ОДИНАКОВО в Android WebView, в service worker MV3-расширения и (через
// полифил) в Node. OPFS отпал именно потому, что в расширении его нет.
//
// Схема:
//   files  — по пути: mtime+size для определения изменений, список чанков
//   chunks — текст фрагмента + координаты для цитаты
//   vectors— одна запись: сериализованная матрица целиком
//
// Матрица пишется ОДНОЙ записью, а не по вектору на строку: 5000 отдельных
// put() в IndexedDB на телефоне — это секунды, один ArrayBuffer — миллисекунды.

const DB_NAME = 'ragbox';
const DB_VERSION = 1;

export function openDB(indexedDB) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// IDBRequest завершается onsuccess, IDBTransaction — oncomplete.
// Ожидание транзакции через promisify висело бы вечно (тот же дефект
// был найден тестом в snapshots-db.mjs).
const promisify = (req) =>
  new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

const txDone = (tx) =>
  new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('транзакция отменена'));
  });

export class Store {
  constructor(db) {
    this.db = db;
  }

  static async open(indexedDB) {
    return new Store(await openDB(indexedDB));
  }

  _tx(names, mode) {
    return this.db.transaction(names, mode);
  }

  /** Все известные файлы: path -> {mtime, size, chunkIds}. */
  async allFiles() {
    const tx = this._tx(['files'], 'readonly');
    const rows = await promisify(tx.objectStore('files').getAll());
    const map = new Map();
    for (const r of rows) map.set(r.path, r);
    return map;
  }

  async putFile(rec) {
    const tx = this._tx(['files'], 'readwrite');
    await promisify(tx.objectStore('files').put(rec));
  }

  async deleteFile(path) {
    const tx = this._tx(['files', 'chunks'], 'readwrite');
    const chunks = tx.objectStore('chunks');
    const idx = chunks.index('byPath');
    const keys = await promisify(idx.getAllKeys(IDBKeyRange.only(path)));
    for (const k of keys) chunks.delete(k);
    tx.objectStore('files').delete(path);
    await txDone(tx);
    return keys.length;
  }

  async putChunks(list) {
    const tx = this._tx(['chunks'], 'readwrite');
    const s = tx.objectStore('chunks');
    for (const c of list) s.put(c);
    await txDone(tx);
  }

  async getChunks(ids) {
    const tx = this._tx(['chunks'], 'readonly');
    const s = tx.objectStore('chunks');
    return Promise.all(ids.map((id) => promisify(s.get(id))));
  }

  async countChunks() {
    const tx = this._tx(['chunks'], 'readonly');
    return promisify(tx.objectStore('chunks').count());
  }

  /** Матрица векторов — одной записью. */
  async saveVectors(serialized) {
    const tx = this._tx(['meta'], 'readwrite');
    await promisify(
      tx.objectStore('meta').put({ key: 'vectors', value: serialized }),
    );
  }

  async loadVectors() {
    const tx = this._tx(['meta'], 'readonly');
    const row = await promisify(tx.objectStore('meta').get('vectors'));
    return row ? row.value : null;
  }

  async clear() {
    const tx = this._tx(['files', 'chunks', 'meta'], 'readwrite');
    tx.objectStore('files').clear();
    tx.objectStore('chunks').clear();
    tx.objectStore('meta').clear();
    await txDone(tx);
  }
}
