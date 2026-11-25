// Общие типы Bun-слоя.
//
// Фрагмент несёт КООРДИНАТУ в оригинале (страница либо таймкод) —
// без неё цитата не указывает, куда смотреть, и теряет смысл.

export interface Chunk {
  id: string;
  /** Путь относительно knowledgebase. */
  path: string;
  ord: number;
  text: string;
  /** Смещения в MD-расшифровке. */
  start: number;
  end: number;
  /** Страница — для PDF и изображений. */
  page?: number;
  /** Таймкод — для аудио и видео. */
  startSec?: number;
  endSec?: number;
  /** Готовая подпись: «с. 3» либо «01:05–01:30». */
  label?: string;
}

export interface Hit {
  index: number;
  id: string;
  score: number;
}

export interface Citation {
  chunk: Chunk;
  score: number;
  via: 'vector' | 'lexical' | 'hybrid';
}

export interface Embedder {
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface Progress {
  phase: 'scan' | 'extract' | 'chunk' | 'embed' | 'store' | 'done';
  done: number;
  total: number;
  file?: string;
  note?: string;
  /** Оценка оставшегося времени в секундах. */
  etaSec?: number;
}
