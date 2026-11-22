// Лексический поиск BM25 + лёгкий русский стеммер.
//
// Зачем вообще, когда есть эмбеддинги: BM25 находит ТОЧНЫЕ совпадения,
// которые вектор размывает — номера («77-АБ»), суммы («300 евро»), имена
// собственные, редкие термины. Замер 2026-11-22: BM25 в одиночку 4/12 R@1,
// E5 8/12, но их СЛИЯНИЕ даёт 8/12 R@1 при R@3 11/12 против 10/12 — то
// есть BM25 вытаскивает то, что вектор не видит, и наоборот.
//
// 🔴 ГЛАВНАЯ ГРАБЛЯ, стоившая целого замера (2026-11-22):
//    `\b` в JS определён через [A-Za-z0-9_] и НЕ РАБОТАЕТ С КИРИЛЛИЦЕЙ.
//    /\b(зуб)/i.test('зуб заболел') === false
//    Из-за этого 17 правил синонимов молча не срабатывали, и измерение
//    показывало «переписывание запроса не даёт прироста» (0/12 изменений).
//    Поэтому здесь НЕТ ни одного `\b`: токенизация идёт через \p{L}\p{N}
//    с флагом u, и это проверяется тестом на кириллице.

/**
 * Токенизация: последовательности букв/цифр, в нижнем регистре.
 * Через \p{L}, а не [a-z], иначе кириллица просто выпадет.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const out = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    const t = m[0].toLowerCase();
    if (t.length > 0) out.push(t);
  }
  return out;
}

// Окончания русского языка, от длинных к коротким. Порядок важен:
// «ость» должно сработать раньше «ю», иначе «беременностью» -> «беременность»
// не произойдёт.
// Окончания русского языка. СОРТИРУЮТСЯ ПО ДЛИНЕ при инициализации:
// порядок в литерале ненадёжен, а короткий суффикс, проверенный раньше
// длинного, обрезает не то («сервисной» -> «сервисно» вместо «сервисн»,
// потому что «й» сработало раньше «ой»). Это была реальная ошибка,
// пойманная попарным тестом словоформ.
const SUFFIXES = [
  // причастия и отглагольные
  'ованиями', 'ованиям', 'ованием', 'ованные', 'ованных', 'ованная',
  'ующий', 'ающий', 'ящий', 'ющий', 'вшись', 'вшийся', 'вшая',
  // существительные
  'остью', 'остей', 'остям', 'ости', 'ость',
  'ениями', 'аниями', 'ениям', 'аниям', 'ением', 'анием',
  'ения', 'ание', 'ания', 'ению', 'анию', 'ении', 'ании', 'ение',
  'иями', 'ями', 'ами', 'ием', 'ьев', 'ьем', 'ией', 'иям', 'иях',
  // прилагательные — полные формы
  'ыми', 'ими', 'ого', 'его', 'ому', 'ему', 'ую', 'юю',
  'ый', 'ий', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие',
  'ой', 'ей', 'ым', 'им', 'ом', 'ем', 'ых', 'их',
  // падежные
  'ах', 'ях', 'ов', 'ев', 'ам', 'ям', 'ми', 'ою', 'ею', 'ью',
  'а', 'я', 'о', 'е', 'у', 'ю', 'ы', 'и', 'ь', 'й',
].sort((a, b) => b.length - a.length);

/**
 * Лёгкий суффиксный стеммер. Не морфологический анализатор, а отсечение
 * окончаний — этого достаточно, чтобы «франшиза»/«франшизы» и
 * «сервисная»/«сервисной» попали в один токен.
 *
 * Короткие слова (<= 4 букв) не трогаем: «дом» -> «д» навредит сильнее,
 * чем помогут совпадения.
 *
 * @param {string} token
 * @returns {string}
 */
export function stem(token) {
  if (token.length <= 4) return token;
  for (const suf of SUFFIXES) {
    if (token.length - suf.length >= 4 && token.endsWith(suf)) {
      return token.slice(0, token.length - suf.length);
    }
  }
  return token;
}

/**
 * Токенизация + стемминг одной операцией.
 * @param {string} text
 * @returns {string[]}
 */
export function analyze(text) {
  return tokenize(text).map(stem);
}

/**
 * Индекс BM25.
 *
 * Параметры k1=1.2, b=0.75 — стандартные. b управляет штрафом за длину
 * документа; для чанков примерно одной длины он почти не играет, но
 * оставлен, потому что PDF-страницы и короткие заметки соседствуют.
 */
export class BM25 {
  /**
   * @param {object} [opts]
   * @param {number} [opts.k1]
   * @param {number} [opts.b]
   */
  constructor({ k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    /** @type {string[]} */
    this.ids = [];
    /** @type {number[]} */
    this.lengths = [];
    /** @type {Map<string, Map<number, number>>} термин -> (док -> частота) */
    this.postings = new Map();
    this.totalLength = 0;
  }

  get size() {
    return this.ids.length;
  }

  get avgLength() {
    return this.size === 0 ? 0 : this.totalLength / this.size;
  }

  /**
   * @param {string} id
   * @param {string} text
   * @returns {number} индекс документа
   */
  add(id, text) {
    const terms = analyze(text);
    const docIndex = this.ids.length;
    this.ids.push(id);
    this.lengths.push(terms.length);
    this.totalLength += terms.length;

    /** @type {Map<string, number>} */
    const freq = new Map();
    for (const t of terms) freq.set(t, (freq.get(t) ?? 0) + 1);

    for (const [term, f] of freq) {
      let p = this.postings.get(term);
      if (!p) {
        p = new Map();
        this.postings.set(term, p);
      }
      p.set(docIndex, f);
    }
    return docIndex;
  }

  /**
   * Удаляет документы по предикату и ПЕРЕСТРАИВАЕТ индекс.
   *
   * Перестройка, а не пометка удалённым: иначе idf считается по мёртвым
   * документам и ранжирование плывёт тем сильнее, чем больше удалено.
   *
   * @param {(id: string) => boolean} pred
   * @param {(id: string) => string | undefined} getText как получить текст уцелевших
   * @returns {number} сколько удалено
   */
  removeWhere(pred, getText) {
    const keep = this.ids.filter((id) => !pred(id));
    const removed = this.ids.length - keep.length;
    if (removed === 0) return 0;

    this.ids = [];
    this.lengths = [];
    this.postings = new Map();
    this.totalLength = 0;
    for (const id of keep) {
      const text = getText(id);
      if (text !== undefined) this.add(id, text);
    }
    return removed;
  }

  /**
   * @param {string} query
   * @param {number} [k]
   * @returns {import('../types/index.js').Hit[]}
   */
  search(query, k = 5) {
    if (this.size === 0) return [];
    const terms = analyze(query);
    if (terms.length === 0) return [];

    const avg = this.avgLength;
    /** @type {Map<number, number>} */
    const scores = new Map();

    for (const term of terms) {
      const p = this.postings.get(term);
      if (!p) continue;
      const df = p.size;
      // idf с +1 внутри логарифма — не уходит в минус на частых терминах
      const idf = Math.log(1 + (this.size - df + 0.5) / (df + 0.5));
      for (const [doc, f] of p) {
        const len = this.lengths[doc] ?? 0;
        const norm = this.k1 * (1 - this.b + (this.b * len) / (avg || 1));
        const add = idf * ((f * (this.k1 + 1)) / (f + norm));
        scores.set(doc, (scores.get(doc) ?? 0) + add);
      }
    }

    return [...scores.entries()]
      .map(([index, score]) => ({ index, id: this.ids[index] ?? '', score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
