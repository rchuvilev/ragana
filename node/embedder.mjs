// Эмбеддер на Transformers.js (multilingual-e5-small, ONNX/WASM).
//
// ЗАМЕРЕНО 2026-11-22 на Redmi Note 10 Pro (Snapdragon 732G, wasm, 4 потока):
//   загрузка модели  7.2 с
//   эмбеддинг        ~438 мс на текст
//   384 измерения, ранжирование корректное (0.87 / 0.80 / 0.69)
//
// ЧЕТЫРЕ ОБХОДА, без которых это не работает в Alpine/musl/aarch64.
// Все проверены вчера; ни один не требует патча библиотеки:
//
// 1. native onnxruntime-node НЕ ЛИНКУЕТСЯ:
//      Error relocating libonnxruntime.so.1: __getauxval: symbol not found
//    Это glibc-символ, здесь musl. Папку node_modules/onnxruntime-node
//    надо просто убрать (см. tools/setup-model.sh).
//
// 2. exports в package.json ЗАПРЕЩАЕТ подпуть ./dist/transformers.web.js.
//    Обход: import по АБСОЛЮТНОМУ ПУТИ — на file:// карта exports не влияет.
//
// 3. Библиотека под Node ВСЕГДА берёт native: проверка IS_NODE_ENV идёт
//    раньше web-ветки и вычисляется ОДИН раз при импорте из
//    process.release.name. Обход: временно скрыть process.release ДО
//    импорта и вернуть после.
//    ⚠️ Глобальный Symbol.for('onnxruntime') НЕ годится: он минует блок,
//    заполняющий supportedDevices, и даёт «Unsupported device: wasm».
//
// 4. web-сборка не линкует node:fs => локальные модели не читаются.
//    Обход: перехват env.fetch, возвращающий new Response(buf) из файла.
//    ⚠️ env.useCustomCache НЕ использовать — отдаёт строку-путь и ломается
//    с ERR_INVALID_URL в web-режиме.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { asPassage, asQuery } from '../core/fusion.mjs';

const DEFAULT_MODEL = 'Xenova/multilingual-e5-small';
const DEFAULT_DIM = 384;

/**
 * @param {string} modelDir каталог с config.json, tokenizer.json и onnx/
 * @param {object} [opts]
 * @param {string} [opts.modelId]
 * @param {boolean} [opts.quantized]
 * @returns {Promise<import('../core/engine.mjs').Embedder>}
 */
export async function createEmbedder(modelDir, opts = {}) {
  const { modelId = DEFAULT_MODEL, quantized = true } = opts;

  const transformersPath = join(
    process.cwd(),
    'node_modules/@huggingface/transformers/dist/transformers.web.js',
  );

  // Обход 3: скрыть process.release до импорта, вернуть сразу после.
  const savedRelease = process.release;
  // @ts-ignore — намеренная временная подмена
  delete process.release;
  /** @type {any} */
  let lib;
  try {
    lib = await import(transformersPath);
  } finally {
    // @ts-ignore
    process.release = savedRelease;
  }

  const { pipeline, env } = lib;

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  // 🔴 ПЯТОЕ препятствие (не встречалось вчера): onnxruntime-web создаёт
  // воркер через blob:-URL, а ESM-загрузчик Node поддерживает только
  // file:/data:/node: => 'no available backend found. ERR: [wasm]
  // ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol blob:'.
  // Однопоточный режим не создаёт воркер вовсе. В БРАУЗЕРЕ это не нужно:
  // там blob: работает, и numThreads=4 даёт реальное ускорение.
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  // wasmPaths ДОЛЖЕН быть file://-URL, а не путём: ESM-загрузчик Node
  // принимает только схемы file:/data:/node:, и голый путь он трактует
  // как https:, уходя на CDN (который здесь недоступен).
  env.backends.onnx.wasm.wasmPaths = pathToFileURL(
    join(process.cwd(), 'node_modules/onnxruntime-web/dist/'),
  ).href;

  // Обход 4: отдаём файлы модели из локального каталога через fetch.
  const originalFetch = env.fetch ?? globalThis.fetch;
  /** @param {any} input @param {any} init */
  env.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? '');
    const marker = `${modelId}/`;
    const idx = url.indexOf(marker);
    if (idx >= 0) {
      const rel = url.slice(idx + marker.length).split('?')[0] ?? '';
      try {
        const buf = await readFile(join(modelDir, rel));
        return new Response(buf, { status: 200 });
      } catch {
        return new Response(null, { status: 404 });
      }
    }
    return originalFetch(input, init);
  };

  const extractor = await pipeline('feature-extraction', modelId, {
    quantized,
    device: 'wasm',
  });

  /** @type {import('../core/engine.mjs').Embedder} */
  return {
    dim: DEFAULT_DIM,
    async embed(texts) {
      if (texts.length === 0) return [];
      const out = await extractor(texts, { pooling: 'mean', normalize: true });
      /** @type {Float32Array[]} */
      const vectors = [];
      const data = out.data;
      const dim = out.dims[out.dims.length - 1] ?? DEFAULT_DIM;
      for (let i = 0; i < texts.length; i++) {
        vectors.push(Float32Array.from(data.slice(i * dim, (i + 1) * dim)));
      }
      return vectors;
    },
  };
}

export { asPassage, asQuery, DEFAULT_MODEL, DEFAULT_DIM };
