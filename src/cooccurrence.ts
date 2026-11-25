// Словарь совместной встречаемости терминов, построенный ИЗ КОРПУСА.
//
// ЗАЧЕМ. Захардкоженные правила расширения покрывают 50% запросов
// (замерено на 14 вопросах), и провалы системные: словарь собран под
// страховку и кадры, поэтому «гарантия», «ипотека», «акт приёмки» в него
// не попадут никогда. Ручным перечислением эту дыру не закрыть — доменов
// бесконечно много.
//
// РЕШЕНИЕ. При индексации считаем, какие термины стоят РЯДОМ в документах
// пользователя. Тогда «ипотека» сама подтянет «ставка», «срок»,
// «погашение» — без единого правила и для любой темы.
//
// Цена: ноль мегабайт (таблица в той же SQLite) и единицы миллисекунд на
// запрос. Для сравнения: модель-переформулировщик стоила бы +300 МБ и
// секунды на генерацию.
//
// 🔴 ЗАМЕР НА МАЛОМ КОРПУСЕ ОПРОВЕРГ ОЖИДАНИЕ (11 вопросов, 21 фрагмент,
// 287 терминов):
//   без расширения              R@1 7/11  MRR 0.82
//   правила (эвристика)         R@1 9/11  MRR 0.89
//   правила + словарь корпуса   R@1 8/11  MRR 0.85  <- ХУЖЕ
// Причина: на таком объёме статистика не отличает термин от служебного
// слова. Словарь добавлял «составляет», «предоставляется», «ежегодный» —
// они правда стоят рядом, но не сужают поиск, а размывают запрос.
// Фильтр по специфичности (1 - freq/total) не помог: при 287 терминах
// ВСЕ выглядят редкими.
//
// ПОЭТОМУ словарь выключен по умолчанию и включается флагом --cooc.
// На корпусе в тысячи документов картина должна смениться: там служебные
// слова действительно станут частыми и отсекутся. Это гипотеза, и
// проверять её надо на настоящем архиве, а не на демо-наборе.

import { Database } from 'bun:sqlite';
import { analyze } from '../core/lexical.mjs';

/** Термины, которые не несут смысла и только зашумляют связи. */
const STOP = new Set([
  'и', 'в', 'на', 'с', 'по', 'не', 'а', 'о', 'от', 'за', 'из', 'к', 'до',
  'для', 'при', 'или', 'что', 'как', 'то', 'же', 'бы', 'ли', 'все', 'это',
  'его', 'их', 'ее', 'был', 'быть', 'есть', 'был', 'etc',
  'the', 'a', 'an', 'of', 'in', 'on', 'to', 'for', 'and', 'or', 'is', 'are',
]);

export interface Related {
  term: string;
  /** Насколько сильно связан с исходным: 0..1. */
  score: number;
}

export class Cooccurrence {
  private db: Database;

  constructor(dbFile: string) {
    this.db = new Database(dbFile, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cooc (
        a     TEXT NOT NULL,
        b     TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (a, b)
      );
      CREATE TABLE IF NOT EXISTS term_freq (
        term  TEXT PRIMARY KEY,
        count INTEGER NOT NULL
      );
    `);
    // Индекс для выборки соседей по убыванию связи
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_cooc_a ON cooc(a, count DESC)');
  }

  /** Полная пересборка: вызывается, когда корпус изменился. */
  clear(): void {
    const tx = this.db.transaction(() => {
      this.db.run('DELETE FROM cooc');
      this.db.run('DELETE FROM term_freq');
    });
    tx();
  }

  /**
   * Учитывает один фрагмент.
   *
   * Окно — весь фрагмент, а не N соседних слов: фрагменты и так режутся
   * по предложениям, то есть представляют связную мысль. Более узкое
   * окно потребовало бы подбора размера, а выигрыш неочевиден.
   *
   * Пары хранятся в ОБЕ стороны: запрос «какие термины рядом с X» должен
   * работать независимо от того, кто в паре первый.
   */
  private pending = new Map<string, number>();
  private pendingFreq = new Map<string, number>();

  add(text: string): void {
    const terms = [...new Set(analyze(text))]
      .filter((t) => t.length >= 4 && !STOP.has(t));
    if (terms.length < 2) return;

    for (const t of terms) {
      this.pendingFreq.set(t, (this.pendingFreq.get(t) ?? 0) + 1);
    }
    for (let i = 0; i < terms.length; i++) {
      for (let j = i + 1; j < terms.length; j++) {
        const a = terms[i]!, b = terms[j]!;
        this.pending.set(`${a}\u0000${b}`, (this.pending.get(`${a}\u0000${b}`) ?? 0) + 1);
        this.pending.set(`${b}\u0000${a}`, (this.pending.get(`${b}\u0000${a}`) ?? 0) + 1);
      }
    }

    // Сброс пачками: по одному INSERT на пару дал бы десятки тысяч
    // операций на документ, что на телефонной флеш-памяти — секунды.
    if (this.pending.size > 20_000) this.flush();
  }

  /** Записывает накопленное в базу. */
  flush(): void {
    if (this.pending.size === 0 && this.pendingFreq.size === 0) return;

    const upsertPair = this.db.prepare(
      `INSERT INTO cooc (a, b, count) VALUES (?, ?, ?)
       ON CONFLICT(a, b) DO UPDATE SET count = count + excluded.count`,
    );
    const upsertFreq = this.db.prepare(
      `INSERT INTO term_freq (term, count) VALUES (?, ?)
       ON CONFLICT(term) DO UPDATE SET count = count + excluded.count`,
    );

    const tx = this.db.transaction(() => {
      for (const [key, n] of this.pending) {
        const sep = key.indexOf('\u0000');
        upsertPair.run(key.slice(0, sep), key.slice(sep + 1), n);
      }
      for (const [term, n] of this.pendingFreq) upsertFreq.run(term, n);
    });
    tx();

    this.pending.clear();
    this.pendingFreq.clear();
  }

  /**
   * Термины, часто встречающиеся рядом с данным.
   *
   * Оценка — доля совместных появлений: count(a,b) / count(a). Это не
   * PMI: PMI переоценивает редкие пары, а нам важны именно устойчивые
   * сочетания, которые стоит добавить к запросу.
   */
  related(term: string, limit = 4, minScore = 0.45): Related[] {
    const stemmed = analyze(term)[0];
    if (!stemmed) return [];

    const own = this.db.query<{ count: number }, [string]>(
      'SELECT count FROM term_freq WHERE term = ?',
    ).get(stemmed)?.count ?? 0;
    // Термин, встреченный один-два раза, статистики не даёт — его
    // «связи» будут случайными.
    if (own < 3) return [];

    // 🔴 Общее число фрагментов нужно, чтобы отсеять СЛУЖЕБНЫЕ слова.
    // Замер показал: словарь добавлял «составляет», «предоставляется»,
    // «ежегодный» — они действительно стоят рядом, но не сужают поиск,
    // а размывают запрос, и MRR падал с 0.89 до 0.85.
    const totalDocs = this.db.query<{ n: number }, []>(
      'SELECT COUNT(DISTINCT term) AS n FROM term_freq',
    ).get()?.n ?? 1;

    const rows = this.db.query<{ b: string; count: number }, [string, number]>(
      'SELECT b, count FROM cooc WHERE a = ? ORDER BY count DESC LIMIT ?',
    ).all(stemmed, limit * 3);

    // Частота каждого кандидата: слишком частый термин — служебный.
    const freqOf = this.db.prepare<{ count: number }, [string]>(
      'SELECT count FROM term_freq WHERE term = ?',
    );

    return rows
      .map((r) => {
        const theirFreq = freqOf.get(r.b)?.count ?? 1;
        // Оценка — не просто доля совместных появлений, а она же,
        // поделённая на распространённость кандидата: термин, который
        // встречается почти везде, связан со ВСЕМ и потому бесполезен.
        const together = r.count / own;
        const specificity = 1 - theirFreq / totalDocs;
        return { term: r.b, score: together * specificity, raw: together };
      })
      .filter((r) => r.raw >= minScore && r.score >= 0.2)
      .sort((a, b) => b.score - a.score)
      .map(({ term, score }) => ({ term, score }))
      .slice(0, limit);
  }

  /**
   * Расширяет запрос терминами из корпуса.
   *
   * Возвращает ТОЛЬКО добавленные термины — вызывающий решает, как их
   * применить. Уже присутствующие в запросе не дублируются.
   */
  expand(query: string, perTerm = 2, total = 6): string[] {
    const queryTerms = analyze(query).filter((t) => t.length >= 4 && !STOP.has(t));
    const have = new Set(queryTerms);
    const added: string[] = [];

    for (const t of queryTerms) {
      for (const r of this.related(t, perTerm)) {
        if (have.has(r.term) || added.includes(r.term)) continue;
        added.push(r.term);
        if (added.length >= total) return added;
      }
    }
    return added;
  }

  stats(): { terms: number; pairs: number } {
    return {
      terms: this.db.query<{ n: number }, []>(
        'SELECT COUNT(*) AS n FROM term_freq',
      ).get()?.n ?? 0,
      pairs: this.db.query<{ n: number }, []>(
        'SELECT COUNT(*) AS n FROM cooc',
      ).get()?.n ?? 0,
    };
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}
