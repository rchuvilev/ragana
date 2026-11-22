// Общие типы проекта. Подключаются через JSDoc:
//   /** @type {import('../types/index.js').FileEntry} */
// Отдельный .d.ts, а не аннотации по месту: одна и та же запись о файле
// ходит через снимки, форматы и индексатор, и расхождение в её форме —
// именно то, что должна ловить проверка типов.

/** Формат, определённый по содержимому/расширению. */
export type Format =
  | 'text' | 'pdf'
  | 'jpeg' | 'png' | 'gif' | 'bmp' | 'webp' | 'heic' | 'tiff'
  | 'zip' | 'unknown';

/** Группа обработки: как файл превращается в текст. */
export type Kind = 'text' | 'pdf' | 'image' | 'archive' | 'unknown';

/** Нужен ли OCR: да / нет / только если нет текстового слоя. */
export type OcrMode = boolean | 'fallback';

export interface FormatInfo {
  kind: Kind;
  parser: string | null;
  parserVersion: number;
  ocr: OcrMode;
}

/** Запись о файле в ФС-снимке. */
export interface FileEntry {
  path: string;
  hash: string;
  size: number;
  mtime: number;
  format?: Format;
  parserVersion?: number;
}

/** То же без пути — как хранится внутри снимка. */
export interface SnapshotFile {
  hash: string;
  size: number;
  mtime: number;
  format: Format;
  parserVersion: number;
}

export interface Snapshot {
  ts: number;
  root: string;
  note: string;
  count: number;
  bytes: number;
  files: Record<string, SnapshotFile>;
}

/** Снимок без тяжёлого files — для списка в интерфейсе. */
export type SnapshotMeta = Omit<Snapshot, 'files'>;

export interface Rename {
  from: string;
  to: string;
  hash: string;
}

/** Результат сравнения двух снимков. */
export interface SnapshotDiff {
  added: string[];
  changed: string[];
  removed: string[];
  renamed: Rename[];
  same: string[];
}

/** Фрагмент документа с координатами для цитаты. */
export interface Chunk {
  id: string;
  path: string;
  text: string;
  /** Смещение в символах от начала извлечённого текста. */
  start: number;
  end: number;
  /** Страница для PDF/скана, если применимо. */
  page?: number;
  /** Порядковый номер фрагмента внутри файла. */
  ord: number;
}

/** Попадание векторного поиска. */
export interface Hit {
  index: number;
  id: string;
  score: number;
}

/** Результат с присоединённым текстом и источником. */
export interface Citation {
  chunk: Chunk;
  score: number;
  /** Чем найдено: вектор, ключевые слова или оба. */
  via: 'vector' | 'lexical' | 'hybrid';
}

export interface SerializedVectors {
  dim: number;
  size: number;
  ids: string[];
  data: Float32Array;
}
