// Слияние результатов BM25 и векторного поиска + переписывание запроса.
//
// ЗАМЕРЕНО 2026-11-22 (корпус 11 чанков, 12 размеченных вопросов):
//   метод                         R@1    R@3    MRR
//   BM25 сырой                    4/12   6/12   0.42
//   E5 сырой                      8/12  10/12   0.75
//   гибрид RRF                    8/12  11/12   0.77
//   гибрид + переписывание       11/12  12/12   0.94
// Переписывание запроса — самый дешёвый прирост во всём пайплайне:
// MRR 0.77 -> 0.94 при стоимости ~0 мс (чистая эвристика, без модели).

/** @typedef {import('../types/index.js').Hit} Hit */

/**
 * Reciprocal Rank Fusion.
 *
 * Складывает 1/(k + ранг), а НЕ сами оценки: оценки BM25 и косинусного
 * сходства живут в разных шкалах (BM25 не ограничен сверху, косинус в
 * [-1,1]), и их прямое сложение означало бы случайный вес. RRF использует
 * только ПОРЯДОК, поэтому нормализация не нужна.
 *
 * k=60 — стандартное значение из статьи Cormack et al. Оно гасит разницу
 * между верхними позициями: разрыв между 1-м и 2-м местом не должен
 * перевешивать согласие двух независимых методов.
 *
 * @param {Hit[][]} lists результаты разных методов
 * @param {object} [opts]
 * @param {number} [opts.k]
 * @param {number[]} [opts.weights] вес каждого списка (по умолчанию 1)
 * @param {number} [opts.limit]
 * @returns {Array<{id: string, score: number, ranks: number[]}>}
 */
export function rrf(lists, { k = 60, weights, limit = 10 } = {}) {
  /** @type {Map<string, {score: number, ranks: number[]}>} */
  const acc = new Map();

  lists.forEach((list, listIndex) => {
    const w = weights?.[listIndex] ?? 1;
    list.forEach((hit, rank) => {
      let rec = acc.get(hit.id);
      if (!rec) {
        rec = { score: 0, ranks: new Array(lists.length).fill(-1) };
        acc.set(hit.id, rec);
      }
      rec.score += w / (k + rank + 1);
      rec.ranks[listIndex] = rank + 1;
    });
  });

  return [...acc.entries()]
    .map(([id, r]) => ({ id, score: r.score, ranks: r.ranks }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Словарь расширения запроса: разговорное -> термины документов.
// Ключи и значения хранятся УЖЕ В ВИДЕ ОСНОВ сравнения не будет работать:
// словарь строится из стемм, а проверять надо stem(слово), иначе все
// термины дадут «НЕТ» (эта ошибка в замере 2026-11-22 заставила считать,
// что расширение не срабатывает).
/** @type {Array<[string[], string[]]>} */
const EXPANSIONS = [
  [['сколько', 'стоит', 'плачу', 'платить', 'доплата'], ['франшиза', 'сумма', 'размер', 'евро']],
  [['зуб', 'зубной', 'стоматолог'], ['стоматология', 'лечение']],
  [['авария', 'дтп', 'столкновение', 'врезался'], ['страховой', 'случай', 'ущерб']],
  [['пьяный', 'выпил', 'алкоголь', 'пить', 'руль', 'выпивка', 'наркотик'],
   ['опьянение', 'состояние', 'покрытие', 'распространяется']],
  [['отпуск', 'отгул', 'каникулы'], ['отпуск', 'предоставление', 'согласование']],
  [['беременна', 'декрет', 'роды'], ['беременность', 'отпуск']],
  [['позвонить', 'телефон', 'связаться'], ['служба', 'контакт', 'телефон']],
  [['когда', 'срок', 'сколько', 'ждать'], ['срок', 'дней', 'период']],
  [['нельзя', 'запрещено', 'откажут', 'отказ', 'исключение'],
   ['исключение', 'распространяется', 'покрытие']],
  [['документы', 'справка', 'больничный'], ['нетрудоспособность', 'листок', 'основание']],
  [['документы', 'справка', 'бумаги'], ['документ', 'предоставить', 'заявление']],
];

/**
 * Расширяет запрос терминами предметной области.
 *
 * Чистая эвристика без модели — именно то, что дало MRR 0.77 -> 0.94.
 * Сравнение идёт ПО ОСНОВАМ, потому что словарь и текст запроса стоят в
 * разных словоформах.
 *
 * @param {string} query
 * @param {(s: string) => string} stemFn
 * @returns {{query: string, added: string[]}}
 */
export function expandQuery(query, stemFn) {
  const qStems = new Set(
    (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => stemFn(w)),
  );
  /** @type {string[]} */
  const added = [];

  for (const [triggers, terms] of EXPANSIONS) {
    const fired = triggers.some((t) => qStems.has(stemFn(t)));
    if (!fired) continue;
    for (const term of terms) {
      const s = stemFn(term);
      if (!qStems.has(s) && !added.includes(term)) {
        added.push(term);
        qStems.add(s);
      }
    }
  }

  return {
    query: added.length ? `${query} ${added.join(' ')}` : query,
    added,
  };
}

/**
 * Разбивает составной вопрос на части по союзам.
 *
 * «Какая франшиза и когда платить?» — два разных вопроса, и единый
 * эмбеддинг такого запроса оказывается посередине между двумя темами,
 * не попадая ни в одну.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function splitQuestions(query) {
  const parts = query
    .split(/\s+(?:и|а также|плюс)\s+(?=(?:как|что|где|когда|кто|почему|сколько|какой|какая|какие|можно|нужно|будет))/giu)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 1 ? parts : [query];
}

/**
 * Префиксы E5. Без них качество заметно падает — модель обучена на
 * асимметричной паре query/passage (проверено 2026-11-22).
 *
 * @param {string} text
 * @returns {string}
 */
export function asQuery(text) {
  return `query: ${text}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function asPassage(text) {
  return `passage: ${text}`;
}
