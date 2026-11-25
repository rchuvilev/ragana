// Расшифровка речи через Transformers.js.
//
// Отдельным модулем и грузится лениво: модель стоит ~24 с загрузки, и
// платить их при индексации текстовых файлов незачем.
//
// ИЗМЕРЕНО (3.74 с аудио, Snapdragon 732G):
//   whisper-tiny  загрузка 24.3 с, распознавание 5.7 с
//   whisper-base  загрузка 23.2 с, распознавание 16.4 с = ×4.4 реального
// Час видео на base ≈ 4.5 часа. Поэтому по умолчанию tiny, а сам ASR
// включается явным флагом.
//
// Если понадобится скорость — модуль заменяется на whisper.cpp (55.5k★)
// без изменений в вызывающем коде: контракт transcribe() тот же.

import { loadTransformers } from './runtime.ts';
import type { AsrSegment } from './extract.ts';

export interface AsrOptions {
  model?: string;
  /** Язык речи; undefined = автоопределение. */
  language?: string;
  onProgress?: (note: string) => void;
}

let cached: { model: string; pipe: unknown } | null = null;

/**
 * Поднимает Transformers.js в Node/Bun.
 *
 * Обходы те же, что для эмбеддера (см. node/embedder.mjs) — они нужны
 * из-за musl и отсутствия native onnxruntime:
 *  1. скрыть process.release до импорта, иначе библиотека выберет native
 *  2. импорт по абсолютному пути (карта exports запрещает подпуть)
 *  3. numThreads=1 — ORT создаёт воркер через blob:, который не грузится
 *  4. wasmPaths как file://-URL, иначе ORT уходит за wasm на CDN
 */
async function loadPipeline(model: string, onProgress?: (n: string) => void) {
  if (cached && cached.model === model) return cached.pipe;

  // Обходы для musl — в src/runtime.ts. Модель whisper тянется с CDN при
  // первом использовании: вшивать её в бинарь незачем, расшифровка и так
  // включается явным флагом и идёт минутами.
  const lib = await loadTransformers();
  (lib.env as Record<string, unknown>).allowRemoteModels = true;

  onProgress?.(`загрузка модели whisper-${model}`);
  const pipe = await (lib.pipeline as any)(
    'automatic-speech-recognition', `Xenova/whisper-${model}`, { quantized: true },
  );
  cached = { model, pipe };
  return pipe;
}

/**
 * Декодирует файл в PCM float32 16 кГц моно — формат, который ждёт whisper.
 * ffmpeg берётся системный: он уже есть и справляется со всеми
 * контейнерами, включая видео, откуда берётся только дорожка.
 */
async function decodeAudio(path: string): Promise<Float32Array> {
  const proc = Bun.spawn([
    'ffmpeg', '-v', 'error', '-i', path,
    '-f', 'f32le', '-ac', '1', '-ar', '16000', '-',
  ], { stdout: 'pipe', stderr: 'pipe' });

  const buf = Buffer.from(await new Response(proc.stdout).arrayBuffer());
  const code = await proc.exited;
  if (code !== 0 || buf.length === 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg не смог декодировать ${path}: ${err.slice(0, 200)}`);
  }
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

export async function transcribe(
  path: string, opts: AsrOptions = {},
): Promise<AsrSegment[]> {
  const { model = 'tiny', language, onProgress } = opts;
  const pipe = await loadPipeline(model, onProgress) as any;

  onProgress?.('декодирование аудио');
  const audio = await decodeAudio(path);
  const seconds = audio.length / 16000;
  onProgress?.(`распознавание ${seconds.toFixed(0)} с`);

  const out = await pipe(audio, {
    task: 'transcribe',
    ...(language ? { language } : {}),
    // Таймкоды обязательны: без них цитата из аудио не указывает, куда
    // слушать, и смысл расшифровки теряется.
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  const chunks: Array<{ timestamp: [number, number | null]; text: string }> =
    out.chunks ?? [];

  if (chunks.length === 0) {
    const text = String(out.text ?? '').trim();
    return text ? [{ start: 0, end: seconds, text }] : [];
  }

  return chunks.map((c) => ({
    start: c.timestamp[0] ?? 0,
    // Последний сегмент может не иметь конца — подставляем длительность
    end: c.timestamp[1] ?? seconds,
    text: c.text,
  }));
}
