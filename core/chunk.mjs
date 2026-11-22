// Разбиение текста на фрагменты с ТОЧНЫМИ координатами в исходнике.
//
// Координаты — не метаданные, а суть: по ним цитата подсвечивается в файле,
// и ошибка в start/end означает цитату, показывающую не тот текст. Поэтому
// инвариант «text === source.slice(start, end)» проверяется тестом на
// КАЖДОМ чанке, а не на выборочных.
//
// Границы режутся по предложениям, а не по символам: обрыв на середине
// фразы портит и эмбеддинг (E5 обучен на связных пассажах), и цитату.
//
// Перекрытие нужно, потому что ответ часто лежит на стыке: вопрос
// «какая франшиза при ДТП» и ответ «...франшиза составляет 300 евро»
// могут оказаться в разных чанках, и без перекрытия не найдётся ни один.

/** @typedef {import('../types/index.js').Chunk} Chunk */

/**
 * Границы предложений для русского и английского.
 *
 * Сокращения («т.е.», «г.», «руб.») дают ложные границы, поэтому точка
 * считается концом предложения только если за ней пробел И следующий
 * непробельный символ — заглавная буква, цифра или кавычка/тире.
 * Это эвристика: она намеренно ошибается в сторону БОЛЕЕ ДЛИННОГО
 * предложения, потому что слипшиеся предложения безвредны для поиска,
 * а разорванное на «т.е.» — это мусорный чанк.
 *
 * @param {string} text
 * @returns {Array<[number, number]>} пары [start, end)
 */
export function sentences(text) {
  /** @type {Array<[number, number]>} */
  const out = [];
  let start = 0;
  const n = text.length;

  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '\n') continue;

    // Серия знаков подряд ("?!.." ) — проглатываем целиком
    let j = i;
    while (j + 1 < n) {
      const next = text[j + 1];
      if (next === '.' || next === '!' || next === '?') j++;
      else break;
    }

    if (ch === '\n') {
      // Пустая строка — надёжная граница абзаца
      const after = text[j + 1];
      if (after === '\n' || j + 1 >= n) {
        let end = j + 1;
        while (end < n && (text[end] === '\n' || text[end] === '\r')) end++;
        if (end > start) out.push([start, end]);
        start = end;
        i = end - 1;
        continue;
      }
      continue; // одиночный перевод строки границей не считается
    }

    // Нужен пробел после знака
    const after = text[j + 1];
    if (after !== undefined && !/\s/.test(after)) continue;

    // Следующий значимый символ
    let k = j + 1;
    while (k < n) {
      const c = text[k];
      if (c === undefined || !/\s/.test(c)) break;
      k++;
    }
    const nextCh = text[k];
    const opensNew =
      k >= n ||
      (nextCh !== undefined &&
        (nextCh === nextCh.toUpperCase() && nextCh !== nextCh.toLowerCase() ||
          /[0-9«"'\-—(\[]/.test(nextCh)));
    if (!opensNew) continue;

    const end = j + 1;
    if (end > start) out.push([start, end]);
    start = end;
    i = end - 1;
  }

  if (start < n) out.push([start, n]);
  return out;
}

/**
 * Разбивает текст на чанки по целевому размеру с перекрытием.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.path] путь файла — попадает в id чанка
 * @param {number} [opts.target] целевой размер в символах
 * @param {number} [opts.overlap] перекрытие в символах
 * @param {(offset: number) => number | undefined} [opts.pageAt] номер страницы по смещению
 * @param {number} [opts.minChunks] на сколько частей делить короткий документ
 * @returns {Chunk[]}
 */
export function chunkText(text, opts = {}) {
  const {
    path = '',
    target = 900,
    overlap = 150,
    pageAt,
    minChunks = 3,
  } = opts;

  if (overlap >= target) {
    throw new Error(`перекрытие ${overlap} >= целевого размера ${target}`);
  }

  /** @type {Chunk[]} */
  const out = [];
  const sents = sentences(text);
  if (sents.length === 0) return out;

  // 🔴 Короткий документ целиком влезает в target и становится ОДНИМ
  // чанком — тогда поиск не может отличить абзац про франшизу от абзаца
  // про опьянение, и весь смысл чанкинга теряется. Замечено на реальном
  // файле 496 символов при target=900: один чанк на весь договор, и
  // ранжирование выдавало регламент отпусков на вопрос про оплату.
  // Для таких документов целевой размер уменьшается так, чтобы вышло
  // хотя бы minChunks частей.
  let effectiveTarget = target;
  if (sents.length >= minChunks && text.length < target * minChunks) {
    effectiveTarget = Math.max(120, Math.ceil(text.length / minChunks));
  }
  const effectiveOverlap = Math.min(overlap, Math.floor(effectiveTarget / 3));

  let i = 0;
  let ord = 0;
  while (i < sents.length) {
    const first = sents[i];
    if (!first) break;
    const start = first[0];
    let end = first[1];
    let j = i;

    // Набираем предложения, пока влезаем в target
    while (j + 1 < sents.length) {
      const next = sents[j + 1];
      if (!next) break;
      if (next[1] - start > effectiveTarget) break;
      end = next[1];
      j++;
    }

    const raw = text.slice(start, end);
    const trimmed = raw.trim();
    const lastOut = out[out.length - 1];
    const isRepeat = lastOut !== undefined && lastOut.text === trimmed;
    if (trimmed.length > 0 && !isRepeat) {
      // Координаты корректируются на обрезанные пробелы, иначе цитата
      // подсветит лишние переводы строк
      const lead = raw.length - raw.trimStart().length;
      const realStart = start + lead;
      const realEnd = realStart + trimmed.length;
      /** @type {Chunk} */
      const chunk = {
        id: `${path}#${ord}`,
        path,
        text: trimmed,
        start: realStart,
        end: realEnd,
        ord,
      };
      const page = pageAt ? pageAt(realStart) : undefined;
      if (page !== undefined) chunk.page = page;
      out.push(chunk);
      ord++;
    }

    if (j + 1 >= sents.length) break;

    // Откат на overlap символов назад — но минимум на одно предложение
    // вперёд, иначе цикл застрянет на длинном предложении.
    //
    // 🔴 РАНЬШЕ ЗДЕСЬ РОЖДАЛИСЬ ДУБЛИКАТЫ: откат мог вернуть i на позицию,
    // с которой уже начинался предыдущий чанк, и следующая итерация
    // набирала РОВНО ТОТ ЖЕ диапазон. На реальном файле 4 из 22 чанков
    // оказались байт-в-байт одинаковыми ([161:322] дважды). В выдаче они
    // занимали по два места из пяти с одинаковой оценкой, вытесняя
    // полезные результаты — именно это делало гибрид хуже чистого E5.
    let back = j;
    let acc = 0;
    while (back > i) {
      const s = sents[back];
      if (!s) break;
      acc += s[1] - s[0];
      if (acc >= effectiveOverlap) break;
      back--;
    }
    const nextI = Math.max(i + 1, back);
    // Защита от повтора: если с новой позиции получится тот же самый
    // диапазон, что уже выдан, сдвигаемся дальше.
    i = nextI;
    const peek = sents[i];
    if (peek && peek[0] === start) i = Math.min(i + 1, sents.length);
  }

  return out;
}

/**
 * Проверка инварианта: текст чанка совпадает с вырезкой из исходника.
 * Используется и в тестах, и как защита при индексации — битые координаты
 * обязаны падать сразу, а не всплыть неверной цитатой через месяц.
 *
 * @param {string} source
 * @param {Chunk[]} chunks
 * @returns {string[]} описания расхождений (пусто = всё верно)
 */
export function verifyOffsets(source, chunks) {
  /** @type {string[]} */
  const bad = [];
  for (const c of chunks) {
    const slice = source.slice(c.start, c.end);
    if (slice !== c.text) {
      bad.push(
        `${c.id}: [${c.start},${c.end}) даёт ${JSON.stringify(slice.slice(0, 40))}, ` +
        `а в чанке ${JSON.stringify(c.text.slice(0, 40))}`,
      );
    }
  }
  return bad;
}
