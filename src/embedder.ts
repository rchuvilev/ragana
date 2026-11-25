// Эмбеддер multilingual-e5-small поверх вшитых в бинарь файлов.
//
// Все обходы для Alpine/musl вынесены в src/runtime.ts — там же причины
// каждого. Здесь остаётся только то, что специфично для этой модели.
//
// ЗАМЕРЕНО: загрузка 5.7-7.7 с, эмбеддинг 205 мс/текст, батч 24 даёт
// 139 мс/текст (ускорение 1.75x против одиночной обработки).

import { EMBEDDER_FILES, isCompiled } from './assets.ts';
import { loadTransformers, serveModelFiles } from './runtime.ts';
import type { Embedder } from './types.ts';

const MODEL_ID = 'Xenova/multilingual-e5-small';
const DIM = 384;

export interface EmbedderInfo {
  compiled: boolean;
  modelFrom: 'бинарь' | 'диск';
}

/** Диагностика: откуда взялись файлы модели. */
export function embedderInfo(): EmbedderInfo {
  return {
    compiled: isCompiled(),
    modelFrom: isCompiled() ? 'бинарь' : 'диск',
  };
}

export async function createEmbedder(): Promise<Embedder> {
  // Загрузка библиотеки и все обходы для musl — в src/runtime.ts,
  // единой точке для эмбеддера, ASR и Florence-2. Раньше этот код был
  // скопирован в три файла.
  const lib = await loadTransformers();
  serveModelFiles(lib, 'multilingual-e5-small/', EMBEDDER_FILES, {
    // Разные сборки просят то model.onnx, то квантованный вариант
    'onnx/model.onnx': 'onnx/model_quantized.onnx',
  });

  const extractor = await (lib.pipeline as any)(
    'feature-extraction', MODEL_ID, { quantized: true, device: 'wasm' },
  );

  return {
    dim: DIM,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const out = await extractor(texts, { pooling: 'mean', normalize: true });
      const dim = out.dims[out.dims.length - 1] ?? DIM;
      const vectors: Float32Array[] = [];
      for (let i = 0; i < texts.length; i++) {
        vectors.push(Float32Array.from(out.data.slice(i * dim, (i + 1) * dim)));
      }
      return vectors;
    },
  };
}
