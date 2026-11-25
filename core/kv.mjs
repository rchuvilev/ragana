// Контракт хранилища «ключ-значение» поверх разных платформ.
//
// ЗАЧЕМ. Модули cache и cooccurrence — чистая логика, но оба завязаны на
// bun:sqlite, которого в браузере нет. Абстракция позволяет писать логику
// один раз: Bun подставляет SQLite, браузер — IndexedDB.
//
// Контракт намеренно узкий: get / set / delete / iterate по префиксу.
// Полноценный SQL в браузере пришлось бы эмулировать (wa-sqlite, 2.2 МБ,
// требует OPFS, недоступного в расширении) — а для наших задач нужен
// именно этот минимум.

/**
 * @typedef {object} KvStore
 * @property {(key: string) => Promise<Uint8Array | null>} get
 * @property {(key: string, value: Uint8Array) => Promise<void>} set
 * @property {(key: string) => Promise<void>} delete
 * @property {(prefix: string) => AsyncIterable<[string, Uint8Array]>} scan
 * @property {(prefix?: string) => Promise<number>} count
 * @property {(prefix?: string) => Promise<void>} clear
 * @property {() => Promise<void>} [close]
 */

/**
 * Хранилище в памяти.
 *
 * Нужно не только для тестов: в браузере индекс можно держать целиком в
 * памяти на время сессии, а в IndexedDB сбрасывать пачкой — так
 * избегаются тысячи мелких транзакций, каждая из которых на телефоне
 * стоит миллисекунды.
 *
 * @returns {KvStore}
 */
export function memoryKv() {
  /** @type {Map<string, Uint8Array>} */
  const data = new Map();

  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
    async *scan(prefix) {
      // Копия ключей: вызывающий может удалять по ходу обхода, а
      // изменение Map во время итерации даёт неопределённое поведение.
      for (const key of [...data.keys()]) {
        if (!key.startsWith(prefix)) continue;
        const value = data.get(key);
        if (value) yield [key, value];
      }
    },
    async count(prefix = '') {
      if (prefix === '') return data.size;
      let n = 0;
      for (const key of data.keys()) if (key.startsWith(prefix)) n++;
      return n;
    },
    async clear(prefix = '') {
      if (prefix === '') {
        data.clear();
        return;
      }
      for (const key of [...data.keys()]) {
        if (key.startsWith(prefix)) data.delete(key);
      }
    },
  };
}

/**
 * Хранилище поверх IndexedDB — единственного, доступного одинаково в
 * браузере, Android WebView и service worker расширения.
 *
 * @param {IDBFactory} factory
 * @param {string} [dbName]
 * @param {string} [storeName]
 * @returns {Promise<KvStore>}
 */
export async function indexedDbKv(factory, dbName = 'ragana-kv', storeName = 'kv') {
  /** @type {IDBDatabase} */
  const db = await new Promise((resolve, reject) => {
    const req = factory.open(dbName, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(storeName)) d.createObjectStore(storeName);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  /**
   * @template T
   * @param {IDBRequest<T>} req
   * @returns {Promise<T>}
   */
  const wait = (req) => new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

  // IDBTransaction завершается oncomplete, НЕ onsuccess — ожидание через
  // onsuccess висело бы вечно (этот дефект уже ловился тестом в
  // core/snapshots-db.mjs).
  /** @param {IDBTransaction} tx */
  const txDone = (tx) => new Promise((res, rej) => {
    tx.oncomplete = () => res(undefined);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error ?? new Error('транзакция отменена'));
  });

  return {
    async get(key) {
      const tx = db.transaction([storeName], 'readonly');
      const v = await wait(tx.objectStore(storeName).get(key));
      return v instanceof Uint8Array ? v : (v ? new Uint8Array(v) : null);
    },
    async set(key, value) {
      const tx = db.transaction([storeName], 'readwrite');
      tx.objectStore(storeName).put(value, key);
      await txDone(tx);
    },
    async delete(key) {
      const tx = db.transaction([storeName], 'readwrite');
      tx.objectStore(storeName).delete(key);
      await txDone(tx);
    },
    async *scan(prefix) {
      const tx = db.transaction([storeName], 'readonly');
      const store = tx.objectStore(storeName);
      // Диапазон по префиксу: '\uffff' — старший код, поэтому верхняя
      // граница покрывает все ключи с этим началом.
      const range = prefix
        ? IDBKeyRange.bound(prefix, prefix + '\uffff')
        : undefined;
      /** @type {IDBValidKey[]} */
      const keys = await wait(store.getAllKeys(range));
      /** @type {any[]} */
      const values = await wait(store.getAll(range));
      for (let i = 0; i < keys.length; i++) {
        const v = values[i];
        if (v) yield [String(keys[i]), v instanceof Uint8Array ? v : new Uint8Array(v)];
      }
    },
    async count(prefix = '') {
      const tx = db.transaction([storeName], 'readonly');
      const range = prefix
        ? IDBKeyRange.bound(prefix, prefix + '\uffff')
        : undefined;
      return wait(tx.objectStore(storeName).count(range));
    },
    async clear(prefix = '') {
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      if (prefix === '') {
        store.clear();
      } else {
        const keys = await wait(store.getAllKeys(
          IDBKeyRange.bound(prefix, prefix + '\uffff'),
        ));
        for (const k of keys) store.delete(k);
      }
      await txDone(tx);
    },
    async close() {
      db.close();
    },
  };
}

// --- помощники для типизированных значений ---

/**
 * @param {Float32Array} vec
 * @returns {Uint8Array}
 */
export function packVector(vec) {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * @param {Uint8Array} bytes
 * @returns {Float32Array}
 */
export function unpackVector(bytes) {
  // Копия, а не вид: исходный буфер может быть переиспользован
  // хранилищем, и тогда вектор молча испортится.
  const copy = new Uint8Array(bytes);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

/**
 * @param {unknown} value
 * @returns {Uint8Array}
 */
export function packJson(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * @param {Uint8Array} bytes
 * @returns {unknown}
 */
export function unpackJson(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}
