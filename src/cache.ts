// Кэш эмбеддингов по хэшу текста.
//
// ИДЕЯ ЗАИМСТВОВАНА У STRATA (docs/HOW_IT_WORKS.md): держать «горячее» в
// быстром хранилище, остальное считать по месту. У нас другая задача —
// модель 113 МБ влезает целиком, так что выгружать эксперты не нужно, —
// но сам принцип переносится на другой уровень: не пересчитывать то, что
// уже считали.
//
// ЧТО ИМЕННО ПЕРЕНОСИМО, А ЧТО НЕТ (решено замером, не рассуждением):
//
//  ✅ «Чтение большими кусками» -> батчинг эмбеддингов.
//     Замер (медиана 3 прогонов): 1 текст 227 мс, 12 текстов 130 мс/текст,
//     48 текстов 128 мс/текст. Плато с ~12. Применено: BATCH 8 -> 24,
//     ускорение 1.75x. Это единственный приём, давший прямой выигрыш.
//
//  ✅ «Горячее в быстрой памяти» -> этот кэш + резидентный режим.
//     Загрузка модели 6.0 с = стоимость 29 эмбеддингов. Для CLI, который
//     стартует на каждый поиск, это ДОМИНИРУЮЩАЯ статья расходов.
//
//  ❌ Параллельная работа GPU и CPU. Нечего распараллеливать: один WASM
//     бэкенд. Замер numThreads: 1 -> 1004 мс, 2 -> 992 мс, 4 -> 988 мс на
//     8 текстов, то есть разница 1.6% — в пределах шума. Причина известна:
//     ORT создаёт воркер через blob:, который Node не грузит, поэтому
//     потоки фактически не включаются.
//
//  ❌ Spec-decoding («угадай, потом проверь»). Приём для АВТОРЕГРЕССИОННОЙ
//     генерации: черновик дешёвой моделью, проверка дорогой. Эмбеддер —
//     один проход энкодера, предсказывать нечего. Появится смысл, только
//     если добавим генерацию ответа.
//
//  ❌ Выгрузка экспертов на SSD. Модель и так целиком в памяти.

import { Database } from 'bun:sqlite';

export interface CacheStats {
  hits: number;
  misses: number;
  stored: number;
}

/**
 * Кэш векторов, переживающий перезапуск процесса.
 *
 * Ключ — хэш ТЕКСТА вместе с именем модели: смена модели обязана
 * инвалидировать кэш, иначе получим векторы из разных пространств в
 * одном индексе, а это тихо ломает ранжирование.
 */
export class EmbeddingCache {
  private db: Database;
  private stats: CacheStats = { hits: 0, misses: 0, stored: 0 };

  constructor(dbFile: string, private model: string, private dim: number) {
    this.db = new Database(dbFile, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        key   TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        dim   INTEGER NOT NULL,
        vec   BLOB NOT NULL,
        used  INTEGER NOT NULL DEFAULT 0,
        at    INTEGER NOT NULL
      )
    `);
    // Индекс по частоте: нужен для вытеснения наименее используемого —
    // прямой аналог адаптивного кэша Strata, только по текстам.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_cache_used ON embedding_cache(used, at)');
  }

  private keyOf(text: string): string {
    const h = new Bun.CryptoHasher('sha256');
    h.update(`${this.model}\u0000${this.dim}\u0000${text}`);
    return h.digest('hex');
  }

  get(text: string): Float32Array | null {
    const row = this.db.query<{ vec: Uint8Array }, [string]>(
      'SELECT vec FROM embedding_cache WHERE key = ?',
    ).get(this.keyOf(text));
    if (!row) {
      this.stats.misses++;
      return null;
    }
    this.stats.hits++;
    const key = this.keyOf(text);
    this.db.run('UPDATE embedding_cache SET used = used + 1 WHERE key = ?', [key]);
    const buf = row.vec;
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }

  put(text: string, vec: Float32Array): void {
    this.db.run(
      'INSERT OR REPLACE INTO embedding_cache (key, model, dim, vec, used, at) VALUES (?, ?, ?, ?, 1, ?)',
      [this.keyOf(text), this.model, this.dim,
       new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength), Date.now()],
    );
    this.stats.stored++;
  }

  /** Вытеснение наименее используемых, чтобы кэш не рос бесконечно. */
  prune(keep = 50_000): number {
    const total = this.db.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM embedding_cache',
    ).get()?.n ?? 0;
    if (total <= keep) return 0;
    this.db.run(
      `DELETE FROM embedding_cache WHERE key IN (
         SELECT key FROM embedding_cache ORDER BY used ASC, at ASC LIMIT ?
       )`, [total - keep],
    );
    return total - keep;
  }

  getStats(): CacheStats & { hitRate: number } {
    const seen = this.stats.hits + this.stats.misses;
    return { ...this.stats, hitRate: seen === 0 ? 0 : this.stats.hits / seen };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Оборачивает эмбеддер кэшем.
 *
 * Пачка разделяется на известное и неизвестное; модель получает ТОЛЬКО
 * неизвестное, и батчинг от этого не страдает — наоборот, пачка из
 * промахов остаётся плотной.
 */
export function withCache(
  embedder: { dim: number; embed: (texts: string[]) => Promise<Float32Array[]> },
  cache: EmbeddingCache,
): { dim: number; embed: (texts: string[]) => Promise<Float32Array[]> } {
  return {
    dim: embedder.dim,
    async embed(texts) {
      const out = new Array<Float32Array | null>(texts.length).fill(null);
      const missIdx: number[] = [];
      const missTexts: string[] = [];

      for (let i = 0; i < texts.length; i++) {
        const hit = cache.get(texts[i]!);
        if (hit) out[i] = hit;
        else {
          missIdx.push(i);
          missTexts.push(texts[i]!);
        }
      }

      if (missTexts.length > 0) {
        const fresh = await embedder.embed(missTexts);
        for (let j = 0; j < missIdx.length; j++) {
          const v = fresh[j];
          if (!v) continue;
          out[missIdx[j]!] = v;
          cache.put(missTexts[j]!, v);
        }
      }

      // Пустой вектор вместо null: вызывающий не должен разбираться с
      // дырами, а нулевой вектор даёт нулевое сходство — то есть просто
      // не попадает в выдачу.
      return out.map((v) => v ?? new Float32Array(embedder.dim));
    },
  };
}
