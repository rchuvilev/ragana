// База RAG на bun:sqlite.
//
// SQLite, а не JSON: при 10 000 фрагментов JSON пришлось бы читать и
// писать целиком на каждое изменение одного файла, а частичная
// индексация — ядро требований. Плюс база переживает падение процесса,
// что для индексации длиной в минуты существенно.
//
// Векторы лежат BLOB'ом (Float32Array как есть), а не массивом чисел:
// 384 float = 1536 байт против ~4 КБ в JSON, и чтение без разбора.

import { Database } from 'bun:sqlite';
import type { Chunk } from './types.ts';

export interface StoredFile {
  rel: string;
  hash: string;
  size: number;
  mtime: number;
  kind: string;
  method: string;
  units: number;
  chunks: number;
  indexedAt: number;
}

export class RagStore {
  private db: Database;

  constructor(dbFile: string, private dim: number) {
    this.db = new Database(dbFile, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    // synchronous=NORMAL: при WAL достаточно для устойчивости к падению
    // процесса, а полный fsync на каждую вставку замедлил бы индексацию
    // в разы на телефонной флеш-памяти.
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        rel       TEXT PRIMARY KEY,
        hash      TEXT NOT NULL,
        size      INTEGER NOT NULL,
        mtime     INTEGER NOT NULL,
        kind      TEXT NOT NULL,
        method    TEXT NOT NULL,
        units     INTEGER NOT NULL,
        chunks    INTEGER NOT NULL,
        indexedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id      TEXT PRIMARY KEY,
        rel     TEXT NOT NULL,
        ord     INTEGER NOT NULL,
        text    TEXT NOT NULL,
        start   INTEGER NOT NULL,
        end     INTEGER NOT NULL,
        page    INTEGER,
        startSec REAL,
        endSec   REAL,
        label   TEXT,
        vec     BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_rel ON chunks(rel);
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  get dimension(): number {
    return this.dim;
  }

  // ---------- файлы ----------

  allFiles(): Map<string, StoredFile> {
    const rows = this.db.query<StoredFile, []>('SELECT * FROM files').all();
    return new Map(rows.map((r) => [r.rel, r]));
  }

  putFile(f: StoredFile): void {
    this.db.run(
      `INSERT OR REPLACE INTO files
       (rel, hash, size, mtime, kind, method, units, chunks, indexedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.rel, f.hash, f.size, f.mtime, f.kind, f.method, f.units, f.chunks, f.indexedAt],
    );
  }

  /**
   * Удаляет файл и ВСЕ его фрагменты одной транзакцией.
   * Частичное удаление оставило бы цитаты из несуществующего документа —
   * худший вид отказа, потому что он молчаливый.
   */
  deleteFile(rel: string): number {
    const tx = this.db.transaction((r: string) => {
      const n = this.db.query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM chunks WHERE rel = ?',
      ).get(r)?.n ?? 0;
      this.db.run('DELETE FROM chunks WHERE rel = ?', [r]);
      this.db.run('DELETE FROM files WHERE rel = ?', [r]);
      return n;
    });
    return tx(rel);
  }

  // ---------- фрагменты ----------

  putChunks(rel: string, chunks: Chunk[], vectors: Float32Array[]): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO chunks
       (id, rel, ord, text, start, end, page, startSec, endSec, label, vec)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      // Старые фрагменты этого файла убираются ВНУТРИ той же транзакции:
      // иначе при падении между удалением и вставкой файл остался бы без
      // фрагментов, числясь проиндексированным.
      this.db.run('DELETE FROM chunks WHERE rel = ?', [rel]);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        const v = vectors[i];
        insert.run(
          c.id, rel, c.ord, c.text, c.start, c.end,
          c.page ?? null, c.startSec ?? null, c.endSec ?? null, c.label ?? null,
          v ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null,
        );
      }
    });
    tx();
  }

  chunkCount(): number {
    return this.db.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM chunks',
    ).get()?.n ?? 0;
  }

  fileCount(): number {
    return this.db.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM files',
    ).get()?.n ?? 0;
  }

  /** Все фрагменты с векторами — для построения поискового индекса. */
  loadChunks(): Array<Chunk & { vec: Float32Array | null }> {
    type Row = {
      id: string; rel: string; ord: number; text: string;
      start: number; end: number;
      page: number | null; startSec: number | null; endSec: number | null;
      label: string | null; vec: Uint8Array | null;
    };
    const rows = this.db.query<Row, []>(
      'SELECT * FROM chunks ORDER BY rel, ord',
    ).all();
    return rows.map((r) => ({
      id: r.id,
      path: r.rel,
      ord: r.ord,
      text: r.text,
      start: r.start,
      end: r.end,
      ...(r.page !== null ? { page: r.page } : {}),
      ...(r.startSec !== null ? { startSec: r.startSec } : {}),
      ...(r.endSec !== null ? { endSec: r.endSec } : {}),
      ...(r.label !== null ? { label: r.label } : {}),
      vec: r.vec
        ? new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
        : null,
    }));
  }

  getMeta(key: string): string | null {
    return this.db.query<{ value: string }, [string]>(
      'SELECT value FROM meta WHERE key = ?',
    ).get(key)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]);
  }

  clear(): void {
    const tx = this.db.transaction(() => {
      this.db.run('DELETE FROM chunks');
      this.db.run('DELETE FROM files');
      this.db.run('DELETE FROM meta');
    });
    tx();
  }

  close(): void {
    this.db.close();
  }
}
