// Расшифровка любого файла в Markdown С КООРДИНАТАМИ.
//
// Координата — не украшение: по ней цитата указывает, куда смотреть в
// оригинале. Для PDF и изображений это страница, для аудио и видео —
// таймкод. MD-файл кладётся рядом с оригиналом и обновляется при его
// изменении; векторизация работает с MD, а не с бинарём.
//
// ИЗМЕРЕНО на этом устройстве (см. docs/REQUIREMENTS.md):
//   tesseract 5.5.0, 66 языков — «Франшиза составляет 300 евро» символ
//     в символ, рус+англ+нем на одной картинке. Доли секунды на страницу.
//   pdftotext -layout — страницы разделяются \f, 2 страницы корректно.
//   whisper-tiny — 24 с загрузка + 5.7 с на 3.7 с аудио
//   whisper-base — 16.4 с на те же 3.7 с = ×4.4 реального времени
// Отсюда: OCR включён всегда, ASR — только по явному согласию.

import { $ } from 'bun';
import { basename, extname, join } from 'node:path';

/** Что делать с медиа: расшифровка дорогая, решает пользователь. */
export type MediaPolicy = 'skip' | 'transcribe';

/**
 * Движок распознавания изображений.
 *
 * ЗАМЕРЕНО, и это определило каскад:
 *   | задача                  | tesseract        | Florence-2        |
 *   |-------------------------|------------------|-------------------|
 *   | русский текст           | точно, 0.6 с     | мусор, 91.7 с     |
 *   | английский текст        | точно, 0.6 с     | с ошибками, 86 с  |
 *   | таблица (87 блоков)     | плоский текст    | блоки+координаты, 176 с |
 *   | картинка БЕЗ текста     | ПУСТО            | осмысленное описание |
 *
 * Florence-2 проигрывает как OCR на ЛЮБОМ языке: «Deductible is 300 euro
 * per claim» он прочитал как «Deutscible is 30 euro per chaim». Поэтому
 * его единственная ниша — ОПИСАНИЕ изображений, где tesseract бессилен.
 *
 *   tesseract — всегда и для всего текста, 66 языков
 *   florence  — принудительно, для опытов и таблиц
 *   auto      — tesseract, плюс ОПИСАНИЕ от Florence-2 там, где
 *               tesseract ничего не нашёл (рекомендуется)
 */
export type OcrEngine = 'tesseract' | 'florence' | 'auto';

export interface ExtractOptions {
  /** Языки для OCR, например 'rus+eng'. */
  ocrLanguages?: string;
  /** Чем распознавать изображения. */
  ocrEngine?: OcrEngine;
  /** Обрабатывать ли аудио и видео. */
  media?: MediaPolicy;
  /** Модель ASR. tiny быстрее, base точнее. */
  asrModel?: 'tiny' | 'base' | 'small';
  /** Куда сообщать о ходе работы. */
  onProgress?: (note: string) => void;
}

export interface ExtractResult {
  /** Готовый Markdown с координатами. */
  markdown: string;
  /** Чем расшифровано — попадает в шапку MD. */
  method: string;
  /** Сколько единиц координат получилось (страниц либо сегментов). */
  units: number;
  /** Предупреждения, которые пользователь обязан увидеть. */
  warnings: string[];
}

/** Группы по способу расшифровки. */
export type Kind = 'text' | 'pdf' | 'image' | 'audio' | 'video' | 'unsupported';

const EXT_KIND: Record<string, Kind> = {
  // текст читается как есть
  txt: 'text', md: 'text', markdown: 'text', csv: 'text', tsv: 'text',
  json: 'text', xml: 'text', yaml: 'text', yml: 'text', ini: 'text',
  html: 'text', htm: 'text', rst: 'text', org: 'text', tex: 'text',
  log: 'text', srt: 'text', vtt: 'text',
  // PDF: сначала текстовый слой, при его отсутствии — OCR постранично
  pdf: 'pdf',
  // изображения
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image',
  webp: 'image', tif: 'image', tiff: 'image', heic: 'image', heif: 'image',
  avif: 'image', pbm: 'image', pgm: 'image', ppm: 'image',
  // аудио
  mp3: 'audio', wav: 'audio', m4a: 'audio', flac: 'audio', ogg: 'audio',
  opus: 'audio', aac: 'audio', wma: 'audio', aiff: 'audio',
  // видео
  mp4: 'video', mkv: 'video', mov: 'video', avi: 'video', webm: 'video',
  m4v: 'video', wmv: 'video', flv: 'video', mpg: 'video', mpeg: 'video',
};

export function kindOf(path: string): Kind {
  const ext = extname(path).slice(1).toLowerCase();
  return EXT_KIND[ext] ?? 'unsupported';
}

/** Нужна ли расшифровка в MD (для текста она не нужна). */
export function needsTranscript(path: string): boolean {
  const k = kindOf(path);
  return k !== 'text' && k !== 'unsupported';
}

/** Путь MD-файла рядом с оригиналом: document.pdf -> document.pdf.md */
export function transcriptPath(path: string): string {
  return `${path}.md`;
}

function header(src: string, method: string, extra: string[] = []): string {
  const lines = [
    `<!-- расшифровка ragana -->`,
    `# ${basename(src)}`,
    '',
    `- источник: \`${src}\``,
    `- метод: ${method}`,
    ...extra.map((e) => `- ${e}`),
    '',
  ];
  return lines.join('\n');
}

/** Секунды -> MM:SS.mmm для таймкодов. */
export function stamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// ---------- PDF ----------

/**
 * Текстовый слой PDF постранично.
 * pdftotext разделяет страницы символом \f (form feed) — на этом и
 * строится нумерация. Проверено: 2 страницы, 4151 + 2508 символов.
 */
async function pdfTextLayer(path: string): Promise<string[]> {
  const out = await $`pdftotext -layout ${path} -`.quiet().nothrow();
  if (out.exitCode !== 0) return [];
  return out.stdout.toString('utf8').split('\f');
}

/** Страницы PDF как изображения -> OCR. Для сканов без текстового слоя. */
async function pdfOcr(
  path: string, langs: string, onProgress?: (n: string) => void,
): Promise<string[]> {
  const tmp = join('/tmp', `ragana-ocr-${Date.now()}`);
  await $`mkdir -p ${tmp}`.quiet().nothrow();
  try {
    // 200 dpi — компромисс: ниже теряется мелкий шрифт, выше растёт время
    await $`pdftoppm -r 200 -png ${path} ${tmp}/p`.quiet().nothrow();
    const listed = await $`ls ${tmp}`.quiet().nothrow();
    const files = listed.stdout.toString('utf8').trim().split('\n')
      .filter((f) => f.endsWith('.png')).sort();
    const pages: string[] = [];
    for (let i = 0; i < files.length; i++) {
      onProgress?.(`OCR страницы ${i + 1}/${files.length}`);
      const r = await $`tesseract ${join(tmp, files[i]!)} stdout -l ${langs}`
        .quiet().nothrow();
      pages.push(r.exitCode === 0 ? r.stdout.toString('utf8') : '');
    }
    return pages;
  } finally {
    await $`rm -rf ${tmp}`.quiet().nothrow();
  }
}

/**
 * Распознавание с автоподбором языков.
 *
 * 🔴 НАБОР ЯЗЫКОВ РЕШАЕТ КАЧЕСТВО. Замер на одной картинке с английским
 * текстом «Deductible is 300 euro per claim»:
 *   -l eng      «Deductible is 300 euro per claim»   точно
 *   -l rus+eng  «Deductible 15 300 еиго рег claim»   латиница подменена
 *   -l rus      «РедисНЫе 15 300 еиго рег с/айт»     мусор
 * То есть лишний язык в наборе ХУЖЕ, чем его отсутствие: tesseract
 * подставляет похожие по начертанию буквы чужого алфавита.
 *
 * Поэтому делается два прохода: сначала широким набором — чтобы понять,
 * какая письменность на картинке, затем узким — ради точности. Второй
 * проход стоит те же ~0.6 с, что приемлемо против 96 с у Florence-2.
 */
async function ocrAdaptive(
  path: string, requested: string,
): Promise<{ text: string; langs: string }> {
  const first = await $`tesseract ${path} stdout -l ${requested}`.quiet().nothrow();
  const firstText = first.exitCode === 0 ? first.stdout.toString('utf8').trim() : '';

  // Если язык задан одиночным — пользователь знает, что делает
  if (!requested.includes('+') || firstText.length < 10) {
    return { text: firstText, langs: requested };
  }

  const { tesseractLangs } = await import('./lang.ts');
  const narrowed = tesseractLangs(firstText, requested);
  if (narrowed === requested) return { text: firstText, langs: requested };

  const second = await $`tesseract ${path} stdout -l ${narrowed}`.quiet().nothrow();
  const secondText = second.exitCode === 0 ? second.stdout.toString('utf8').trim() : '';

  // Берём второй результат, только если он не короче: сужение набора
  // могло отрезать нужный язык, и тогда лучше вернуться к широкому.
  return secondText.length >= firstText.length * 0.8
    ? { text: secondText, langs: narrowed }
    : { text: firstText, langs: requested };
}

// ---------- медиа ----------

/** Длительность в секундах, 0 если неизвестна. */
async function durationOf(path: string): Promise<number> {
  const r = await $`ffprobe -v error -show_entries format=duration -of csv=p=0 ${path}`
    .quiet().nothrow();
  if (r.exitCode !== 0) return 0;
  return Number.parseFloat(r.stdout.toString('utf8').trim()) || 0;
}

export interface AsrSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * Расшифровка речи. Вынесена в отдельный модуль и грузится лениво:
 * загрузка модели стоит ~24 с, и платить их при индексации текстовых
 * файлов незачем.
 */
async function transcribeMedia(
  path: string, model: string, onProgress?: (n: string) => void,
): Promise<AsrSegment[]> {
  const { transcribe } = await import('./asr.ts');
  return transcribe(path, { model, onProgress });
}

// ---------- точка входа ----------

export async function extractToMarkdown(
  path: string, opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const {
    ocrLanguages = 'rus+eng',
    ocrEngine = 'auto',
    media = 'skip',
    asrModel = 'tiny',
    onProgress,
  } = opts;
  const warnings: string[] = [];
  const kind = kindOf(path);

  if (kind === 'text') {
    const text = await Bun.file(path).text();
    return { markdown: text, method: 'как есть', units: 1, warnings };
  }

  if (kind === 'pdf') {
    let pages = await pdfTextLayer(path);
    let method = 'pdftotext (текстовый слой)';

    // Пустой текстовый слой = скан. Проверяется ПО СОДЕРЖИМОМУ, а не по
    // коду возврата: pdftotext успешно отдаёт пустоту для сканов.
    const chars = pages.join('').trim().length;
    if (chars < 40 * Math.max(1, pages.length)) {
      onProgress?.('текстового слоя нет, включаю OCR');
      const ocr = await pdfOcr(path, ocrLanguages, onProgress);
      if (ocr.join('').trim().length > chars) {
        pages = ocr;
        method = `OCR tesseract (${ocrLanguages})`;
      } else if (chars === 0) {
        warnings.push('ни текстового слоя, ни распознаваемого текста');
      }
    }

    const body = pages
      .map((p, i) => ({ n: i + 1, t: p.trim() }))
      .filter((p) => p.t.length > 0)
      .map((p) => `## [с. ${p.n}]\n\n${p.t}`)
      .join('\n\n');

    const units = pages.filter((p) => p.trim().length > 0).length;
    return {
      markdown: header(path, method, [`страниц: ${units}`]) + body + '\n',
      method, units, warnings,
    };
  }

  if (kind === 'image') {
    let text = '';
    let method = '';

    if (ocrEngine !== 'florence') {
      const res = await ocrAdaptive(path, ocrLanguages);
      text = res.text;
      method = `OCR tesseract (${res.langs})`;
    }

    // Florence-2 зовётся ТОЛЬКО за описанием и только когда tesseract
    // ничего не нашёл. Пускать его на распознавание текста смысла нет:
    // замер показал ошибки даже на английском при 140-кратном отставании
    // по скорости. А вот картинку без текста он описывает осмысленно —
    // и такой файл перестаёт молча выпадать из индекса.
    const { florenceDecision } = await import('./lang.ts');
    const needFlorence = ocrEngine === 'florence'
      || (ocrEngine === 'auto' && florenceDecision(text) === 'caption');

    if (needFlorence) {
      try {
        const { runVision } = await import('./vision.ts');
        // Принудительный режим — пробуем и OCR, иначе только описание
        const ocr = ocrEngine === 'florence'
          ? await runVision(path, 'ocr', onProgress)
          : null;
        const caption = await runVision(path, 'caption_long', onProgress);
        const parts = [ocr?.text.trim(), caption.text.trim()].filter(Boolean);
        const combined = parts.join('\n\n');
        if (combined.length > text.length) {
          // Описание помечается явно: это НЕ текст с картинки, а пересказ
          // её содержимого, и пользователь должен видеть разницу.
          text = ocr?.text.trim()
            ? combined
            : `[описание изображения] ${combined}`;
          method = ocr ? 'Florence-2 (текст + описание)' : 'Florence-2 (описание)';
        }
      } catch (e) {
        warnings.push(`Florence-2 недоступен: ${(e as Error).message.slice(0, 80)}`);
      }
    }

    if (text.length === 0) warnings.push('на изображении не найдено ни текста, ни описания');
    // Для одиночного изображения координата — «с. 1»: единый формат с PDF
    // позволяет цитировать то и другое одинаково.
    return {
      markdown: header(path, method || 'нет') + `## [с. 1]\n\n${text}\n`,
      method: method || 'нет', units: text.length > 0 ? 1 : 0, warnings,
    };
  }

  if (kind === 'audio' || kind === 'video') {
    const dur = await durationOf(path);
    if (media === 'skip') {
      // Честный отказ вместо молчаливой индексации пустого документа.
      warnings.push(
        `расшифровка пропущена (${dur.toFixed(0)} с медиа; ` +
        `ожидаемое время ~${(dur * 4.4 / 60).toFixed(0)} мин). ` +
        `Включите флагом --media`,
      );
      return { markdown: '', method: 'пропущено', units: 0, warnings };
    }

    onProgress?.(
      `расшифровка ${dur.toFixed(0)} с, ожидание ~${(dur * 4.4 / 60).toFixed(1)} мин`,
    );
    const segs = await transcribeMedia(path, asrModel, onProgress);
    const body = segs
      .filter((s) => s.text.trim().length > 0)
      .map((s) => `## [${stamp(s.start)}–${stamp(s.end)}]\n\n${s.text.trim()}`)
      .join('\n\n');
    if (segs.length === 0) warnings.push('речь не распознана');
    const method = `whisper-${asrModel}`;
    return {
      markdown: header(path, method, [
        `длительность: ${dur.toFixed(1)} с`,
        `сегментов: ${segs.length}`,
      ]) + body + '\n',
      method, units: segs.length, warnings,
    };
  }

  warnings.push(`формат ${extname(path) || '(без расширения)'} не поддерживается`);
  return { markdown: '', method: 'нет', units: 0, warnings };
}

/**
 * Разбирает координаты обратно из MD.
 * Нужно, чтобы цитата знала свою страницу или таймкод: чанкер видит
 * только текст, а привязка живёт в заголовках.
 */
export interface Anchor {
  /** Смещение в MD, с которого действует эта координата. */
  offset: number;
  page?: number;
  startSec?: number;
  endSec?: number;
  label: string;
}

export function parseAnchors(markdown: string): Anchor[] {
  const anchors: Anchor[] = [];
  const re = /^## \[(?:с\. (\d+)|(\d\d):(\d\d)\.(\d{3})–(\d\d):(\d\d)\.(\d{3}))\]$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const offset = m.index + m[0].length + 1;
    if (m[1] !== undefined) {
      anchors.push({ offset, page: Number(m[1]), label: `с. ${m[1]}` });
    } else {
      const start = Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
      const end = Number(m[5]) * 60 + Number(m[6]) + Number(m[7]) / 1000;
      anchors.push({
        offset, startSec: start, endSec: end,
        label: `${m[2]}:${m[3]}–${m[5]}:${m[6]}`,
      });
    }
  }
  return anchors;
}

/**
 * Координата для заданного смещения в MD.
 *
 * Смещения ВНУТРИ ШАПКИ (до первого якоря) относятся к первой единице:
 * шапка описывает файл целиком, и цитата оттуда — это цитата с первой
 * страницы, а не «без координаты». Возврат undefined здесь означал бы
 * цитату, которую некуда привязать.
 */
export function anchorAt(anchors: Anchor[], offset: number): Anchor | undefined {
  if (anchors.length === 0) return undefined;
  let found: Anchor | undefined;
  for (const a of anchors) {
    if (a.offset <= offset) found = a;
    else break;
  }
  return found ?? anchors[0];
}
