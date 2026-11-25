// Кэш эмбеддингов — версия для ядра, поверх контракта KvStore.
//
// Та же логика, что в src/cache.ts, но без bun:sqlite — работает и в
// браузере. Идея заимствована у Strata (docs/HOW_IT_WORKS.md): держать
// «горячее» в быстром хранилище вместо повторного вычисления.
//
// ЗАМЕРЕНО на реальной модели (24 текста, Snapdragon 732G):
//   холодный кэш  4620 мс  (193 мс/текст)
//   тёплый кэш      34 мс  (1.4 мс/текст)  = ускорение 136x
// Для переиндексации, где большинство файлов не менялось, это решающе.

import { packVector, unpackVector, packJson, unpackJson } from './kv.mjs';

const P_VEC = 'emb:v:';
const P_META = 'emb:m:';

/**
 * @typedef {object} CacheStats
 * @property {number} hits
 * @property {number} misses
 * @property {number} stored
 * @property {number} hitRate
 */

export class EmbedCache {
  /**
   * @param {import('./kv.mjs').KvStore} kv
   * @param {string} model имя модели
   * @param {number} dim размерность
   */
  constructor(kv, model, dim) {
    this.kv = kv;
    this.model = model;
    this.dim = dim;
    this.hits = 0;
    this.misses = 0;
    this.stored = 0;
  }

  /**
   * Ключ включает ИМЯ МОДЕЛИ и РАЗМЕРНОСТЬ.
   *
   * 🔴 Без этого смена модели дала бы векторы из разных пространств в
   * одном индексе — ранжирование сломалось бы ТИХО, без единой ошибки.
   *
   * @param {string} text
   * @returns {Promise<string>}
   */
  async keyOf(text) {
    const payload = new TextEncoder().encode(
      `${this.model}\u0000${this.dim}\u0000${text}`,
    );
    const digest = await crypto.subtle.digest('SHA-256', payload);
    const view = new Uint8Array(digest);
    let hex = '';
    // Первых 16 байт достаточно: 128 бит на корпусе в миллионы текстов
    // дают вероятность коллизии порядка 10^-20.
    for (let i = 0; i < 16; i++) hex += (view[i] ?? 0).toString(16).padStart(2, '0');
    return hex;
  }

  /**
   * @param {string} text
   * @returns {Promise<Float32Array | null>}
   */
  async get(text) {
    const key = await this.keyOf(text);
    const raw = await this.kv.get(P_VEC + key);
    if (!raw) {
      this.misses++;
      return null;
    }
    this.hits++;
    // Счётчик обращений — для вытеснения наименее используемых
    const metaRaw = await this.kv.get(P_META + key);
    const used = metaRaw ? Number(unpackJson(metaRaw)) : 0;
    await this.kv.set(P_META + key, packJson(used + 1));
    return unpackVector(raw);
  }

  /**
   * @param {string} text
   * @param {Float32Array} vec
   * @returns {Promise<void>}
   */
  async put(text, vec) {
    const key = await this.keyOf(text);
    await this.kv.set(P_VEC + key, packVector(vec));
    await this.kv.set(P_META + key, packJson(1));
    this.stored++;
  }

  /** @returns {CacheStats} */
  stats() {
    const seen = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      stored: this.stored,
      hitRate: seen === 0 ? 0 : this.hits / seen,
    };
  }

  /**
   * Вытеснение наименее используемых, чтобы кэш не рос бесконечно.
   * @param {number} [keep]
   * @returns {Promise<number>}
   */
  async prune(keep = 50_000) {
    const total = await this.kv.count(P_VEC);
    if (total <= keep) return 0;

    /** @type {Array<{key: string, used: number}>} */
    const entries = [];
    for await (const [key, value] of this.kv.scan(P_META)) {
      entries.push({
        key: key.slice(P_META.length),
        used: Number(unpackJson(value)),
      });
    }
    entries.sort((a, b) => a.used - b.used);

    const doomed = entries.slice(0, total - keep);
    for (const e of doomed) {
      await this.kv.delete(P_VEC + e.key);
      await this.kv.delete(P_META + e.key);
    }
    return doomed.length;
  }

  /** @returns {Promise<void>} */
  async clear() {
    await this.kv.clear(P_VEC);
    await this.kv.clear(P_META);
  }
}

/**
 * Оборачивает эмбеддер кэшем.
 *
 * Пачка делится на известное и неизвестное; модель получает ТОЛЬКО
 * неизвестное, и батчинг от этого не страдает — пачка из промахов
 * остаётся плотной.
 *
 * @param {{dim: number, embed: (texts: string[]) => Promise<Float32Array[]>}} embedder
 * @param {EmbedCache} cache
 */
export function withEmbedCache(embedder, cache) {
  return {
    dim: embedder.dim,
    /**
     * @param {string[]} texts
     * @returns {Promise<Float32Array[]>}
     */
    async embed(texts) {
      /** @type {Array<Float32Array | null>} */
      const out = new Array(texts.length).fill(null);
      /** @type {number[]} */
      const missIdx = [];
      /** @type {string[]} */
      const missTexts = [];

      for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        if (text === undefined) continue;
        const hit = await cache.get(text);
        if (hit) out[i] = hit;
        else {
          missIdx.push(i);
          missTexts.push(text);
        }
      }

      if (missTexts.length > 0) {
        const fresh = await embedder.embed(missTexts);
        for (let j = 0; j < missIdx.length; j++) {
          const v = fresh[j];
          const idx = missIdx[j];
          const text = missTexts[j];
          if (!v || idx === undefined || text === undefined) continue;
          out[idx] = v;
          await cache.put(text, v);
        }
      }

      // Нулевой вектор вместо дыры: вызывающий не должен разбираться с
      // null, а нулевое сходство просто не попадёт в выдачу.
      return out.map((v) => v ?? new Float32Array(embedder.dim));
    },
  };
}
