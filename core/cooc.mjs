// Словарь совместной встречаемости — версия для ядра.
//
// Та же логика, что в src/cooccurrence.ts, но поверх контракта KvStore
// вместо bun:sqlite. Благодаря этому работает и в браузере, где SQLite
// нет: Bun подставляет SQLite-хранилище, браузер — IndexedDB.
//
// 🔴 ЗАМЕР НА МАЛОМ КОРПУСЕ ОПРОВЕРГ ОЖИДАНИЕ (11 вопросов, 21 фрагмент,
// 287 терминов):
//   без расширения              R@1 7/11  MRR 0.82
//   правила (эвристика)         R@1 9/11  MRR 0.89
//   правила + словарь корпуса   R@1 8/11  MRR 0.85  <- ХУЖЕ
// Причина: на таком объёме статистика не отличает термин от служебного
// слова, и словарь добавлял «составляет», «предоставляется» — они правда
// стоят рядом, но не сужают поиск, а размывают запрос.
// Поэтому словарь включается явным флагом, а не по умолчанию.

import { analyze } from './lexical.mjs';
import { packJson, unpackJson } from './kv.mjs';

/** Префиксы ключей: одно хранилище делится между подсистемами. */
const P_PAIR = 'cooc:p:';
const P_FREQ = 'cooc:f:';

/** Термины, которые не несут смысла и только зашумляют связи. */
const STOP = new Set([
  'и', 'в', 'на', 'с', 'по', 'не', 'а', 'о', 'от', 'за', 'из', 'к', 'до',
  'для', 'при', 'или', 'что', 'как', 'то', 'же', 'бы', 'ли', 'все', 'это',
  'его', 'их', 'ее', 'был', 'быть', 'есть',
  'the', 'a', 'an', 'of', 'in', 'on', 'to', 'for', 'and', 'or', 'is', 'are',
]);

/**
 * @typedef {object} Related
 * @property {string} term
 * @property {number} score насколько сильно связан: 0..1
 */

export class Cooc {
  /** @param {import('./kv.mjs').KvStore} kv */
  constructor(kv) {
    this.kv = kv;
    /** @type {Map<string, number>} накопленные пары до сброса */
    this.pendingPairs = new Map();
    /** @type {Map<string, number>} накопленные частоты */
    this.pendingFreq = new Map();
  }

  /**
   * Учитывает один фрагмент.
   *
   * Окно — весь фрагмент: они и так режутся по предложениям, то есть
   * представляют связную мысль. Пары хранятся в ОБЕ стороны, иначе
   * запрос «что рядом с X» зависел бы от порядка в паре.
   *
   * @param {string} text
   */
  add(text) {
    const terms = [...new Set(analyze(text))]
      .filter((t) => t.length >= 4 && !STOP.has(t));
    if (terms.length < 2) return;

    for (const t of terms) {
      this.pendingFreq.set(t, (this.pendingFreq.get(t) ?? 0) + 1);
    }
    for (let i = 0; i < terms.length; i++) {
      for (let j = i + 1; j < terms.length; j++) {
        const a = terms[i], b = terms[j];
        if (a === undefined || b === undefined) continue;
        const k1 = `${a}\u0000${b}`;
        const k2 = `${b}\u0000${a}`;
        this.pendingPairs.set(k1, (this.pendingPairs.get(k1) ?? 0) + 1);
        this.pendingPairs.set(k2, (this.pendingPairs.get(k2) ?? 0) + 1);
      }
    }
  }

  /**
   * Записывает накопленное.
   *
   * Пачкой, а не по паре: на документ приходятся тысячи пар, и
   * пооперационная запись в IndexedDB — это секунды.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    if (this.pendingPairs.size === 0 && this.pendingFreq.size === 0) return;

    for (const [key, n] of this.pendingPairs) {
      const dbKey = P_PAIR + key;
      const existing = await this.kv.get(dbKey);
      const prev = existing ? Number(unpackJson(existing)) : 0;
      await this.kv.set(dbKey, packJson(prev + n));
    }
    for (const [term, n] of this.pendingFreq) {
      const dbKey = P_FREQ + term;
      const existing = await this.kv.get(dbKey);
      const prev = existing ? Number(unpackJson(existing)) : 0;
      await this.kv.set(dbKey, packJson(prev + n));
    }

    this.pendingPairs.clear();
    this.pendingFreq.clear();
  }

  /**
   * Термины, часто встречающиеся рядом с данным.
   *
   * Оценка — доля совместных появлений count(a,b)/count(a), а не PMI:
   * PMI переоценивает редкие пары, а нам нужны устойчивые сочетания.
   *
   * @param {string} term
   * @param {number} [limit]
   * @param {number} [minScore]
   * @returns {Promise<Related[]>}
   */
  async related(term, limit = 4, minScore = 0.45) {
    const stemmed = analyze(term)[0];
    if (!stemmed) return [];

    const ownRaw = await this.kv.get(P_FREQ + stemmed);
    const own = ownRaw ? Number(unpackJson(ownRaw)) : 0;
    // Термин, встреченный один-два раза, даёт случайные связи
    if (own < 3) return [];

    /** @type {Related[]} */
    const found = [];
    for await (const [key, value] of this.kv.scan(P_PAIR + stemmed + '\u0000')) {
      const other = key.slice((P_PAIR + stemmed + '\u0000').length);
      if (!other) continue;
      const score = Number(unpackJson(value)) / own;
      if (score >= minScore) found.push({ term: other, score });
    }

    return found.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Расширяет запрос терминами из корпуса.
   *
   * @param {string} query
   * @param {number} [perTerm]
   * @param {number} [total]
   * @returns {Promise<string[]>}
   */
  async expand(query, perTerm = 2, total = 6) {
    const queryTerms = analyze(query).filter((t) => t.length >= 4 && !STOP.has(t));
    const have = new Set(queryTerms);
    /** @type {string[]} */
    const added = [];

    for (const t of queryTerms) {
      for (const r of await this.related(t, perTerm)) {
        if (have.has(r.term) || added.includes(r.term)) continue;
        added.push(r.term);
        if (added.length >= total) return added;
      }
    }
    return added;
  }

  /** @returns {Promise<{terms: number, pairs: number}>} */
  async stats() {
    return {
      terms: await this.kv.count(P_FREQ),
      pairs: await this.kv.count(P_PAIR),
    };
  }

  /** @returns {Promise<void>} */
  async clear() {
    this.pendingPairs.clear();
    this.pendingFreq.clear();
    await this.kv.clear(P_PAIR);
    await this.kv.clear(P_FREQ);
  }
}
