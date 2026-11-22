// Извлечение текстового слоя PDF без внешних зависимостей.
//
// Почему не pdf.js: это ~1.5 МБ, который пришлось бы тащить и в WebView,
// и в расширение, причём ради одной операции. Здесь разбираются потоки
// содержимого и операторы показа текста — этого достаточно для PDF с
// текстовым слоем (договоры, выписки, инструкции), то есть для большинства
// документов, которые человек кладёт в папку.
//
// ЧЕГО ЭТО НЕ УМЕЕТ, честно:
//   - сканы и фото: там нет текстового слоя вообще, нужен OCR
//   - шифрованные PDF
//   - экзотические кодировки CID без ToUnicode
// Во всех этих случаях возвращается пустой/короткий текст, и вызывающий
// обязан это заметить — см. looksEmpty().

import { inflateSync } from 'node:zlib';

/**
 * Декодирует ASCII85 (фильтр /ASCII85Decode).
 *
 * 🔴 Этот фильтр НЕ был учтён в первой версии, и на реальном PDF
 * (Flights_AGP-RIX, 51 КБ) извлекалось РОВНО 0 символов при шести
 * успешно распакованных Flate-потоках. Диагноз дал позитивный контроль:
 * у двух потоков фильтр оказался КАСКАДОМ [/ASCII85Decode /FlateDecode],
 * и inflate падал с 'incorrect header check'. Ноль на выходе — всегда
 * повод проверить, а не принять.
 *
 * @param {Buffer} input
 * @returns {Buffer}
 */
function ascii85Decode(input) {
  let s = input.toString('latin1');
  const start = s.indexOf('<~');
  if (start >= 0) s = s.slice(start + 2);
  const end = s.indexOf('~>');
  if (end >= 0) s = s.slice(0, end);
  s = s.replace(/\s/g, '');

  /** @type {number[]} */
  const out = [];
  let tuple = 0;
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === 'z' && count === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = s.charCodeAt(i) - 33;
    if (code < 0 || code > 84) continue;
    tuple = tuple * 85 + code;
    count++;
    if (count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    for (let i = 0; i < count - 1; i++) out.push(bytes[i] ?? 0);
  }
  return Buffer.from(out);
}

/**
 * Находит все объекты потока и распаковывает их.
 * @param {Uint8Array} bytes
 * @returns {Array<{header: string, data: string, objNum: number}>}
 */
function extractStreams(bytes) {
  /** @type {Array<{header: string, data: string, objNum: number}>} */
  const out = [];
  const buf = Buffer.from(bytes);
  const latin = buf.toString('latin1');

  let pos = 0;
  while (true) {
    const start = latin.indexOf('stream', pos);
    if (start === -1) break;
    const end = latin.indexOf('endstream', start);
    if (end === -1) break;

    // Заголовок объекта перед stream — ищем фильтр
    const headStart = Math.max(0, latin.lastIndexOf('obj', start) - 40);
    const header = latin.slice(headStart, start);

    let dataStart = start + 'stream'.length;
    if (latin[dataStart] === '\r') dataStart++;
    if (latin[dataStart] === '\n') dataStart++;

    // Фильтры применяются КАСКАДОМ в порядке объявления:
    // /Filter [ /ASCII85Decode /FlateDecode ] означает сперва ascii85, потом inflate
    /** @type {Buffer} */
    let data = Buffer.from(buf.subarray(dataStart, end));
    try {
      if (/ASCII85Decode/.test(header)) data = ascii85Decode(data);
      if (/FlateDecode/.test(header)) data = inflateSync(data);
      if (!/DCTDecode|JPXDecode|CCITTFaxDecode/.test(header)) {
        const numMatch = /(\d+)\s+\d+\s+obj/.exec(header);
        out.push({
          header,
          data: data.toString('latin1'),
          objNum: numMatch ? Number(numMatch[1]) : -1,
        });
      }
    } catch {
      // битый, зашифрованный или нетекстовый поток — в PDF полно потоков,
      // которые нас не интересуют (шрифты, картинки)
    }

    pos = end + 'endstream'.length;
  }
  return out;
}

/**
 * Снимает PDF-экранирование внутри строкового литерала.
 * @param {string} s
 * @returns {string}
 */
function unescapePdfString(s) {
  return s.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (_, code) => {
    switch (code) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case '(': return '(';
      case ')': return ')';
      case '\\': return '\\';
      default: return String.fromCharCode(parseInt(code, 8));
    }
  });
}

/**
 * Декодирует hex-строку <...> в текст.
 * Чаще всего это UTF-16BE, что типично для кириллицы в PDF.
 * @param {string} hex
 * @returns {string}
 */
function decodeHexString(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const bytes = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
    }
    return out;
  }
  return bytes.map((b) => String.fromCharCode(b)).join('');
}

/**
 * Вытаскивает текст из потока содержимого страницы.
 *
 * Интересуют операторы Tj, TJ, ' и " — всё, что показывает текст.
 * TJ принимает массив, где числа — кернинг; крупный отрицательный сдвиг
 * означает пробел, поэтому он восстанавливается.
 *
 * @param {string} content
 * @returns {string}
 */
function textFromContent(content) {
  /** @type {string[]} */
  const parts = [];
  // литералы (...) и <...> вместе с предшествующим оператором
  const re = /(\[(?:[^\]\\]|\\.)*\]|\((?:[^)\\]|\\.)*\)|<[0-9a-fA-F\s]*>)\s*(TJ|Tj|'|")/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const body = m[1] ?? '';
    const op = m[2];

    if (body.startsWith('[')) {
      // TJ: массив строк и чисел
      const inner = /(\((?:[^)\\]|\\.)*\)|<[0-9a-fA-F\s]*>|-?[\d.]+)/g;
      let im;
      let piece = '';
      while ((im = inner.exec(body)) !== null) {
        const tok = im[1] ?? '';
        if (tok.startsWith('(')) {
          piece += unescapePdfString(tok.slice(1, -1));
        } else if (tok.startsWith('<')) {
          piece += decodeHexString(tok.slice(1, -1));
        } else {
          const n = parseFloat(tok);
          if (n <= -100) piece += ' '; // крупный сдвиг = пробел
        }
      }
      parts.push(piece);
    } else if (body.startsWith('(')) {
      parts.push(unescapePdfString(body.slice(1, -1)));
    } else {
      parts.push(decodeHexString(body.slice(1, -1)));
    }

    if (op === "'" || op === '"') parts.push('\n');
  }

  return parts.join('');
}

/**
 * Разбирает карту ToUnicode (CMap) субсет-шрифта.
 *
 * 🔴 БЕЗ ЭТОГО теряются ВСЕ не-ASCII символы. На реальном PDF «Málaga»
 * приходила как «M\200laga»: субсет-шрифт нумерует глифы с нуля, и код
 * 0x80 означает «á» только согласно его собственной карте. Кириллица в
 * таких PDF пострадала бы целиком, а не одной буквой.
 *
 * @param {string} cmap
 * @returns {Map<number, string>}
 */
function parseToUnicode(cmap) {
  /** @type {Map<number, string>} */
  const map = new Map();

  // bfchar: <src> <dst>
  const charBlocks = cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? [];
  for (const block of charBlocks) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let m;
    while ((m = re.exec(block)) !== null) {
      const src = parseInt(m[1] ?? '', 16);
      const dst = m[2] ?? '';
      map.set(src, hexToUtf16(dst));
    }
  }

  // bfrange: <lo> <hi> <dstStart>  либо  <lo> <hi> [<d1> <d2> ...]
  const rangeBlocks = cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? [];
  for (const block of rangeBlocks) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
    let m;
    while ((m = re.exec(block)) !== null) {
      const lo = parseInt(m[1] ?? '', 16);
      const hi = parseInt(m[2] ?? '', 16);
      if (m[3] !== undefined) {
        const base = parseInt(m[3], 16);
        for (let c = lo; c <= hi; c++) {
          map.set(c, String.fromCodePoint(base + (c - lo)));
        }
      } else if (m[4] !== undefined) {
        const items = m[4].match(/<([0-9a-fA-F]+)>/g) ?? [];
        items.forEach((it, i) => {
          map.set(lo + i, hexToUtf16(it.slice(1, -1)));
        });
      }
    }
  }
  return map;
}

/**
 * @param {string} hex
 * @returns {string}
 */
function hexToUtf16(hex) {
  let out = '';
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const code = parseInt(hex.slice(i, i + 4), 16);
    if (!Number.isNaN(code)) out += String.fromCharCode(code);
  }
  return out;
}

/**
 * Применяет карту ToUnicode к извлечённому тексту.
 * @param {string} text
 * @param {Map<number, string>} map
 * @returns {string}
 */
function applyCMap(text, map) {
  if (map.size === 0) return text;
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const mapped = map.get(code);
    out += mapped !== undefined ? mapped : ch;
  }
  return out;
}

/**
 * Извлекает текст из PDF.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function extractPdfText(bytes) {
  const streams = extractStreams(bytes);

  // Собираем карты ToUnicode из всех потоков, которые ими являются.
  // Карты объединяются: субсет-шрифты в одном документе обычно не
  // конфликтуют по кодам, а разбирать привязку шрифт->поток ради
  // этого — несоразмерная сложность.
  /** @type {Map<number, string>} */
  const cmap = new Map();
  for (const st of streams) {
    if (!/beginbfchar|beginbfrange/.test(st.data)) continue;
    for (const [k, v] of parseToUnicode(st.data)) {
      if (!cmap.has(k)) cmap.set(k, v);
    }
  }

  /** @type {string[]} */
  const pages = [];
  for (const st of streams) {
    if (!/\b(Tj|TJ)\b/.test(st.data)) continue; // не текстовый поток
    const t = applyCMap(textFromContent(st.data), cmap);
    if (t.trim().length > 0) pages.push(t);
  }
  return pages
    .join('\n\n')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Признак того, что текстового слоя нет и нужен OCR.
 *
 * Отдельной функцией, потому что «пустой результат» обязан быть ЯВНЫМ
 * решением вызывающего, а не молча проиндексированным пустым документом.
 *
 * @param {string} text
 * @param {number} [minChars]
 * @returns {boolean}
 */
export function looksEmpty(text, minChars = 40) {
  return text.trim().length < minChars;
}
