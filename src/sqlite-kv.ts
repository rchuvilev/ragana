// Хранилище KvStore поверх bun:sqlite.
//
// Третья реализация того же контракта (наряду с memoryKv и
// indexedDbKv), и тот же набор тестов проходит по всем трём. Логика
// cooc и embed-cache написана ОДИН раз и работает везде: Bun получает
// SQLite, браузер — IndexedDB.
//
// Лежит в src/, а не в core/: bun:sqlite вне Bun не существует, и
// попытка проверить такой импорт из ядра честно падает с TS2307 —
// сигнал, что файл платформенный.

import { Database } from 'bun:sqlite';
import type { KvStore } from '../core/kv.mjs';

export function sqliteKv(db: Database, table = 'kv'): KvStore {
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
    k TEXT PRIMARY KEY,
    v BLOB NOT NULL
  )`);

  const get = db.prepare(`SELECT v FROM ${table} WHERE k = ?`);
  const put = db.prepare(`INSERT OR REPLACE INTO ${table} (k, v) VALUES (?, ?)`);
  const del = db.prepare(`DELETE FROM ${table} WHERE k = ?`);

  /** LIKE с экранированием: префикс может содержать % и _ */
  const likeOf = (prefix: string): string =>
    prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`) + '%';

  return {
    async get(key) {
      const row = get.get(key) as { v: Uint8Array } | null;
      return row ? new Uint8Array(row.v) : null;
    },

    async set(key, value) {
      put.run(key, value);
    },

    async delete(key) {
      del.run(key);
    },

    async *scan(prefix) {
      const rows = db.prepare(
        `SELECT k, v FROM ${table} WHERE k LIKE ? ESCAPE '\\'`,
      ).all(likeOf(prefix)) as Array<{ k: string; v: Uint8Array }>;
      for (const r of rows) yield [r.k, new Uint8Array(r.v)];
    },

    async count(prefix = '') {
      if (prefix === '') {
        const row = db.prepare(
          `SELECT COUNT(*) AS n FROM ${table}`,
        ).get() as { n: number };
        return row.n;
      }
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE k LIKE ? ESCAPE '\\'`,
      ).get(likeOf(prefix)) as { n: number };
      return row.n;
    },

    async clear(prefix = '') {
      if (prefix === '') db.run(`DELETE FROM ${table}`);
      else db.run(`DELETE FROM ${table} WHERE k LIKE ? ESCAPE '\\'`, [likeOf(prefix)]);
    },
  };
}
