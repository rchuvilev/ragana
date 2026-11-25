// RAG-поиск поверх базы.
//
// Главное назначение — отдавать контекст в пайплайн к любой модели,
// поэтому результат обязан быть машиночитаемым и содержать координаты:
// модель, получившая цитату без указания страницы, не сможет на неё
// сослаться, и пользователь не сможет проверить.

import { VectorStore } from '../core/vector.mjs';
import { BM25, stem } from '../core/lexical.mjs';
import { rrf, expandQuery, asQuery, splitQuestions } from '../core/fusion.mjs';
import { link, mergeAdjacent, dropped } from '../core/cite.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RagStore } from './store.ts';
import { Cooccurrence } from './cooccurrence.ts';
import type { Chunk, Citation, Embedder } from './types.ts';

export type SearchMode = 'hybrid' | 'vector' | 'lexical';

export interface SearchOptions {
  k?: number;
  pool?: number;
  expand?: boolean;
  merge?: boolean;
  mode?: SearchMode;
  /**
   * Нижний порог косинусного сходства. Ниже — считаем, что не нашли.
   *
   * 🔴 БЕЗ ЭТОГО ПОРОГА векторный поиск ВСЕГДА что-то возвращает:
   * «ближайший» существует даже для бессмыслицы. E2E поймал это на
   * запросе «квазимодокракозябра» — три цитаты и код возврата 0, то
   * есть пайплайн считал поиск успешным и скармливал модели мусор.
   */
  minScore?: number;
}

export interface SearchResult {
  prompt: string;
  /** Итоговый запрос (первый из подзапросов — для совместимости). */
  query: string;
  /** Все подзапросы: составной вопрос разбивается на части. */
  queries: string[];
  added: string[];
  citations: Citation[];
  dropped: string[];
  tookMs: number;
}

/**
 * Поисковый индекс, собранный из базы.
 *
 * Строится в памяти при каждом запуске: 5000 фрагментов — это 7.7 МБ
 * векторов, и их загрузка дешевле, чем поддержание согласованного
 * индекса на диске. Проверено замером: поиск перебором по 50 000
 * фрагментов занимает 47 мс против 205 мс на эмбеддинг одного запроса.
 */
export class Searcher {
  private vectors: VectorStore;
  private bm25: BM25;
  private byId = new Map<string, Chunk>();

  /** Корень документов — нужен, чтобы восстановить текст склеенных цитат. */
  private docsDir: string | null = null;
  /** Словарь из корпуса; null, если ещё не построен. */
  private cooc: Cooccurrence | null = null;

  /** Подключает словарь совместной встречаемости. */
  setCooccurrence(c: Cooccurrence): void {
    this.cooc = c;
  }

  setDocsDir(dir: string): void {
    this.docsDir = dir;
  }

  constructor(private store: RagStore, private embedder: Embedder) {
    this.vectors = new VectorStore(embedder.dim);
    this.bm25 = new BM25();

    for (const row of store.loadChunks()) {
      const { vec, ...chunk } = row;
      this.byId.set(chunk.id, chunk as Chunk);
      this.bm25.add(chunk.id, chunk.text);
      if (vec && vec.length === embedder.dim) this.vectors.add(chunk.id, vec);
    }
  }

  get chunkCount(): number {
    return this.byId.size;
  }

  get vectorCount(): number {
    return this.vectors.size;
  }

  async search(prompt: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const {
      k = 5, pool = 20, expand = true, merge = true, mode = 'hybrid',
      // 🔴 ПОРОГ ПОДОБРАН ЗАМЕРОМ, а не на глаз. E5 выдаёт ВЫСОКИЕ
      // сходства даже для бессмыслицы — это свойство модели, а не
      // ошибка. Замер на 5 осмысленных и 5 бессмысленных запросах:
      //   осмысленные  0.825 … 0.885  (минимум 0.825)
      //   бессмыслица  0.769 … 0.796  (максимум 0.796)
      // Разрыв всего 0.028, середина — 0.811.
      //
      // ⚠️ Разрыв УЗКИЙ, и на другом корпусе границы сместятся. Поэтому
      // порог вынесен в параметр: --min-score позволяет его подвинуть,
      // не пересобирая. Жёсткая константа здесь была бы ловушкой.
      minScore = 0.811,
    } = opts;
    const t0 = Date.now();

    // 🔴 СОСТАВНОЙ ВОПРОС РАЗБИВАЕТСЯ НА ЧАСТИ.
    // «Какая франшиза и когда платить» — два разных вопроса, и единый
    // эмбеддинг такого запроса оказывается ПОСЕРЕДИНЕ между темами, не
    // попадая ни в одну. Каждая часть ищется отдельно, а результаты
    // сливаются одним RRF — пользователь получает единый список.
    const parts = splitQuestions(prompt);

    const queries: string[] = [];
    const added: string[] = [];
    /** Списки попаданий от всех подзапросов — вход для общего слияния. */
    const lists: Array<Array<{ index: number; id: string; score: number }>> = [];

    for (const part of parts) {
      const exp = expand
        ? expandQuery(part, stem)
        : { query: part, added: [] as string[] };

      // Словарь из корпуса дополняет эвристику: правила знают только свой
      // домен (страховка, кадры), а словарь — тот, что у пользователя.
      // Порядок важен: сначала правила, потом корпус — правила точнее,
      // когда срабатывают, но срабатывают лишь в половине случаев.
      let query = exp.query;
      const partAdded = [...exp.added];
      if (expand && this.cooc) {
        for (const t of this.cooc.expand(part)) {
          if (!partAdded.includes(t)) partAdded.push(t);
        }
        if (partAdded.length > exp.added.length) {
          query = `${exp.query} ${partAdded.slice(exp.added.length).join(' ')}`;
        }
      }

      queries.push(query);
      for (const a of partAdded) if (!added.includes(a)) added.push(a);

      if (mode !== 'vector') {
        lists.push(this.bm25.search(query, pool));
      }
      if (mode !== 'lexical' && this.vectors.size > 0) {
        const [qv] = await this.embedder.embed([asQuery(query)]);
        if (qv) {
          // Отсекаем по АБСОЛЮТНОМУ сходству до слияния: RRF работает с
          // рангами и после него разницу между 0.87 и 0.69 уже не видно.
          lists.push(this.vectors.search(qv, pool)
            .filter((h) => h.score >= minScore));
        }
      }
    }

    // Единый RRF по всем спискам сразу: фрагмент, найденный несколькими
    // подзапросами, поднимается — и это правильно, он отвечает на
    // большую часть исходного вопроса.
    const fused = rrf(lists, { limit: Math.max(k * 3, pool) });
    const lost = dropped(fused, this.byId);
    let cites = link(fused, this.byId, { limit: merge ? k * 2 : k });

    if (merge) {
      // mergeAdjacent ОБНУЛЯЕТ text: склеенный фрагмент описан только
      // интервалом [start, end), а текст восстанавливается из исходника.
      // Без этого шага первая цитата приходила ПУСТОЙ (видно в --json).
      const merged = mergeAdjacent(cites).slice(0, k);
      cites = await this.rehydrate(merged);
    }

    return {
      prompt,
      query: queries[0] ?? prompt,
      queries,
      added,
      citations: cites as Citation[],
      dropped: lost,
      tookMs: Date.now() - t0,
    };
  }

  /**
   * Возвращает текст склеенным цитатам.
   *
   * Источник — MD-расшифровка (или сам файл, если он текстовый): именно
   * в её системе координат записаны start/end. Если файл недоступен,
   * собираем текст из уцелевших фрагментов, чтобы цитата не пропала.
   */
  private async rehydrate(cites: Citation[]): Promise<Citation[]> {
    const cache = new Map<string, string | null>();

    const sourceText = async (rel: string): Promise<string | null> => {
      if (cache.has(rel)) return cache.get(rel)!;
      let text: string | null = null;
      if (this.docsDir) {
        for (const candidate of [`${rel}.md`, rel]) {
          try {
            text = await readFile(join(this.docsDir, candidate), 'utf8');
            break;
          } catch { /* пробуем следующий */ }
        }
      }
      cache.set(rel, text);
      return text;
    };

    const out: Citation[] = [];
    for (const c of cites) {
      if (c.chunk.text.length > 0) {
        out.push(c);
        continue;
      }
      const src = await sourceText(c.chunk.path);
      const text = src
        ? src.slice(c.chunk.start, c.chunk.end)
            .replace(/^#{1,6} \[[^\]]*\]\s*$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
        : this.fromChunks(c);
      if (text.length > 0) out.push({ ...c, chunk: { ...c.chunk, text } });
    }
    return out;
  }

  /** Запасной путь: склеить текст из фрагментов, попавших в интервал. */
  private fromChunks(c: Citation): string {
    const parts: string[] = [];
    for (const chunk of this.byId.values()) {
      if (chunk.path !== c.chunk.path) continue;
      if (chunk.start >= c.chunk.start && chunk.end <= c.chunk.end) {
        parts.push(chunk.text);
      }
    }
    return parts.join('\n\n').trim();
  }
}

/** Человекочитаемая подпись источника с координатой. */
export function sourceOf(chunk: Chunk): string {
  const name = chunk.path;
  if (chunk.label) return `${name} (${chunk.label})`;
  if (chunk.page !== undefined) return `${name} (с. ${chunk.page})`;
  return name;
}
