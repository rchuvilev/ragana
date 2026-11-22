// Линкинг цитат и валидатор ссылок.
//
// ПРИНЦИП, определяющий всю конструкцию:
//   экстрактивно (выбор / сортировка / группировка)  ≠
//   абстрактивно (порождение нового текста)
// Для страховки, медицины и права допустим только первый режим: текст
// ответа ЦИТИРУЕТСЯ дословно, а модель (если она вообще есть) возвращает
// JSON со ссылками на чанки — заголовки она придумывать может, текст нет.
// Тогда галлюцинация в фактах структурно невозможна: нечего выдумывать.
//
// Валидатор проверяет, что каждая ссылка указывает на существующий чанк
// и что интервал цитаты лежит в его границах. Невалидная структура ->
// деградация к сырой выдаче, а не показ выдуманного.

/** @typedef {import('../types/index.js').Chunk} Chunk */
/** @typedef {import('../types/index.js').Citation} Citation */

/**
 * Присоединяет тексты чанков к результатам поиска.
 *
 * @param {Array<{id: string, score: number, ranks?: number[]}>} ranked
 * @param {Map<string, Chunk>} byId
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @returns {Citation[]}
 */
export function link(ranked, byId, { limit = 5 } = {}) {
  /** @type {Citation[]} */
  const out = [];
  for (const r of ranked) {
    const chunk = byId.get(r.id);
    if (!chunk) continue; // чанк удалён — молча пропускаем, см. dropped()
    /** @type {Citation['via']} */
    let via = 'vector';
    if (r.ranks) {
      const inLex = (r.ranks[0] ?? -1) > 0;
      const inVec = (r.ranks[1] ?? -1) > 0;
      via = inLex && inVec ? 'hybrid' : inLex ? 'lexical' : 'vector';
    }
    out.push({ chunk, score: r.score, via });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Ссылки, указывающие на несуществующие чанки.
 *
 * Отдельной функцией, а не молчаливым пропуском внутри link(): такие
 * ссылки означают рассинхронизацию индекса с хранилищем, и это нужно
 * видеть, а не прятать.
 *
 * @param {Array<{id: string}>} ranked
 * @param {Map<string, Chunk>} byId
 * @returns {string[]}
 */
export function dropped(ranked, byId) {
  return ranked.filter((r) => !byId.has(r.id)).map((r) => r.id);
}

/**
 * Схлопывает соседние чанки одного файла в непрерывный фрагмент.
 *
 * Перекрытие при чанкинге означает, что два соседних попадания содержат
 * общий текст, и показывать его дважды — шум. Склейка идёт по
 * КООРДИНАТАМ, поэтому результат остаётся дословной вырезкой исходника.
 *
 * @param {Citation[]} cites
 * @returns {Citation[]}
 */
export function mergeAdjacent(cites) {
  /** @type {Map<string, Citation[]>} */
  const byPath = new Map();
  for (const c of cites) {
    const list = byPath.get(c.chunk.path);
    if (list) list.push(c);
    else byPath.set(c.chunk.path, [c]);
  }

  /** @type {Citation[]} */
  const out = [];
  for (const list of byPath.values()) {
    list.sort((a, b) => a.chunk.start - b.chunk.start);
    /** @type {Citation[]} */
    const merged = [];
    for (const c of list) {
      const prev = merged.length > 0 ? merged[merged.length - 1] : undefined;
      if (prev && c.chunk.start <= prev.chunk.end) {
        // пересекаются или встык — расширяем интервал.
        // text обнуляется: после склейки он восстанавливается из исходника
        // через rehydrate(), чтобы цитата осталась ДОСЛОВНОЙ вырезкой.
        merged[merged.length - 1] = {
          chunk: {
            ...prev.chunk,
            start: Math.min(prev.chunk.start, c.chunk.start),
            end: Math.max(prev.chunk.end, c.chunk.end),
            text: '',
          },
          score: Math.max(prev.score, c.score),
          via: prev.via === c.via ? prev.via : 'hybrid',
        };
      } else {
        merged.push({ ...c });
      }
    }
    out.push(...merged);
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Восстанавливает текст склеенных цитат из исходника.
 * Вызывается ПОСЛЕ mergeAdjacent, которая обнуляет text.
 *
 * @param {Citation[]} cites
 * @param {(path: string) => string | undefined} getSource
 * @returns {Citation[]}
 */
export function rehydrate(cites, getSource) {
  return cites.map((c) => {
    if (c.chunk.text !== '') return c;
    const src = getSource(c.chunk.path);
    if (src === undefined) return c;
    return { ...c, chunk: { ...c.chunk, text: src.slice(c.chunk.start, c.chunk.end) } };
  });
}

/**
 * @typedef {object} StructureRef
 * @property {string} chunkId
 * @property {number} [start] смещение ВНУТРИ текста чанка
 * @property {number} [end]
 */

/**
 * @typedef {object} StructureSection
 * @property {string} heading порождается моделью — это ДОПУСТИМО
 * @property {StructureRef[]} refs текст берётся отсюда дословно
 */

/**
 * Проверяет структуру ответа, пришедшую от модели.
 *
 * Возвращает список нарушений. Пустой список — структуру можно показывать;
 * непустой — деградация к сырой выдаче. Ни при каких условиях нельзя
 * показывать частично валидную структуру: отсутствие одной ссылки меняет
 * смысл остальных.
 *
 * @param {unknown} data
 * @param {Map<string, Chunk>} byId
 * @returns {string[]}
 */
export function validateStructure(data, byId) {
  /** @type {string[]} */
  const errs = [];

  if (data === null || typeof data !== 'object') {
    return ['структура не является объектом'];
  }
  const sections = /** @type {{sections?: unknown}} */ (data).sections;
  if (!Array.isArray(sections)) {
    return ['отсутствует массив sections'];
  }
  if (sections.length === 0) {
    return ['sections пуст'];
  }

  sections.forEach((sec, si) => {
    if (sec === null || typeof sec !== 'object') {
      errs.push(`sections[${si}]: не объект`);
      return;
    }
    const s = /** @type {{heading?: unknown, refs?: unknown}} */ (sec);
    if (typeof s.heading !== 'string' || s.heading.trim() === '') {
      errs.push(`sections[${si}]: пустой heading`);
    }
    if (!Array.isArray(s.refs) || s.refs.length === 0) {
      errs.push(`sections[${si}]: нет ссылок refs`);
      return;
    }
    s.refs.forEach((ref, ri) => {
      const where = `sections[${si}].refs[${ri}]`;
      if (ref === null || typeof ref !== 'object') {
        errs.push(`${where}: не объект`);
        return;
      }
      const r = /** @type {StructureRef} */ (ref);
      if (typeof r.chunkId !== 'string') {
        errs.push(`${where}: chunkId не строка`);
        return;
      }
      const chunk = byId.get(r.chunkId);
      if (!chunk) {
        // Самый важный случай: модель сослалась на несуществующий чанк
        errs.push(`${where}: чанк ${r.chunkId} не существует`);
        return;
      }
      const len = chunk.text.length;
      const start = r.start ?? 0;
      const end = r.end ?? len;
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        errs.push(`${where}: нецелые границы`);
        return;
      }
      if (start < 0 || end > len || start >= end) {
        errs.push(`${where}: интервал [${start},${end}) вне чанка длиной ${len}`);
      }
    });
  });

  return errs;
}

/**
 * Собирает текст по валидированной структуре. Текст ТОЛЬКО вырезается,
 * никогда не порождается — заголовки берутся от модели, содержимое из чанков.
 *
 * @param {{sections: StructureSection[]}} structure
 * @param {Map<string, Chunk>} byId
 * @returns {Array<{heading: string, quotes: Array<{text: string, path: string, page?: number}>}>}
 */
export function renderStructure(structure, byId) {
  return structure.sections.map((sec) => ({
    heading: sec.heading,
    quotes: sec.refs.flatMap((r) => {
      const chunk = byId.get(r.chunkId);
      if (!chunk) return [];
      const text = chunk.text.slice(r.start ?? 0, r.end ?? chunk.text.length);
      /** @type {{text: string, path: string, page?: number}} */
      const q = { text, path: chunk.path };
      if (chunk.page !== undefined) q.page = chunk.page;
      return [q];
    }),
  }));
}

/**
 * Человекочитаемая ссылка на источник.
 * @param {Chunk} chunk
 * @returns {string}
 */
export function sourceLabel(chunk) {
  const name = chunk.path.slice(chunk.path.lastIndexOf('/') + 1) || chunk.path;
  return chunk.page !== undefined ? `${name}, с. ${chunk.page}` : name;
}
