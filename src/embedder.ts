// Эмбеддер поверх вшитых ресурсов.
//
// Отличие от node/embedder.mjs: файлы модели берутся из бинаря, а не с
// диска. Четыре обхода для Alpine/musl те же — они нужны из-за
// отсутствия native onnxruntime:
//   1. скрыть process.release до импорта, иначе выбирается native
//   2. импорт по абсолютному пути (карта exports запрещает подпуть)
//   3. numThreads=1 — ORT создаёт воркер через blob:, Node его не грузит
//   4. wasmPaths как file://-URL, иначе ORT уходит за wasm на CDN
//
// ЗАМЕРЕНО: загрузка 5.7-7.7 с, эмбеддинг 205 мс/текст, батч 24 даёт
// 139 мс/текст (ускорение 1.75x против одиночной обработки).

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EMBEDDER_FILES, isCompiled, materializeOrt, materializeLib } from './assets.ts';
// Статический импорт втягивает библиотеку В БИНАРЬ. Обход с
// process.release остаётся нужен: он влияет на выбор бэкенда ВНУТРИ
// библиотеки, который вычисляется при её инициализации.
// 🔴 БИБЛИОТЕКА ГРУЗИТСЯ ДИНАМИЧЕСКИ, А НЕ СТАТИЧЕСКИМ ИМПОРТОМ.
//
// Статический импорт web-сборки ломается неустранимо: при
// IS_NODE_ENV && return_path в loadResourceFile стоит ПУСТАЯ ветка
// (transformers.web.js:7578), result остаётся undefined, и всё падает
// с 'Unable to get model file path or buffer'. А IS_NODE_ENV
// вычисляется ОДИН РАЗ при инициализации модуля из process.release.name,
// то есть подменить его после импорта нельзя.
//
// Динамический импорт позволяет скрыть process.release ДО загрузки
// модуля — тогда IS_NODE_ENV ложен, библиотека идёт по web-ветке и
// работает через перехват env.fetch. Это тот же приём, что в
// node/embedder.mjs, где он проверен замером (205 мс/текст).
//
// Цена: библиотека не вшивается в бинарь и должна лежать рядом.
// Попытка вшить её статически стоила трёх часов отладки — записано,
// чтобы не повторять.
import type { Embedder } from './types.ts';

const MODEL_ID = 'Xenova/multilingual-e5-small';
const DIM = 384;

/**
 * Каталог с библиотекой Transformers.js и wasm-рантаймом.
 *
 * Эти два пакета вшить нельзя: onnxruntime-web подгружает .wasm по пути
 * во время работы, а не импортом. Поэтому в собранном виде они должны
 * лежать рядом либо путь задаётся через RAGANA_LIB_ROOT.
 */
function libRoot(): string {
  return process.env.RAGANA_LIB_ROOT ?? process.cwd();
}

export interface EmbedderInfo {
  compiled: boolean;
  modelFrom: 'бинарь' | 'диск';
  libRoot: string;
}

export function embedderInfo(): EmbedderInfo {
  return {
    compiled: isCompiled(),
    modelFrom: isCompiled() ? 'бинарь' : 'диск',
    libRoot: libRoot(),
  };
}

export async function createEmbedder(): Promise<Embedder> {
  // Рантайм ONNX раскладывается во временный каталог: ORT ищет .wasm по
  // имени, а виртуальная ФС бинаря даёт имена с хэшами.
  const ortDir = await materializeOrt();

  // Библиотека раскладывается из вшитых ресурсов — бинарю не нужен
  // node_modules на диске.
  const libPath = await materializeLib();

  // Прячем process.release ДО импорта: IS_NODE_ENV вычисляется при
  // инициализации модуля и после импорта уже не меняется.
  const savedRelease = process.release;
  // @ts-expect-error намеренная временная подмена
  delete process.release;
  let lib: any;
  try {
    lib = await import(libPath);
  } finally {
    // @ts-expect-error возвращаем на место
    process.release = savedRelease;
  }

  const { pipeline, env } = lib;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  // 🔴 useFS НЕ ВКЛЮЧАТЬ: web-сборка не линкует node:fs, и попытка даёт
  // 'node_fs_default.existsSync is not a function'. Файлы отдаются через
  // перехват env.fetch ниже, а localModelPath задаёт лишь префикс URL,
  // по которому мы их узнаём.
  env.localModelPath = '/models/';

  // env.backends.onnx.wasm создаётся лениво: при статическом импорте
  // web-сборки его ещё нет, и прямое присваивание падало с
  // 'undefined is not an object'. Достраиваем ветку сами.
  env.backends ??= {};
  env.backends.onnx ??= {};
  env.backends.onnx.wasm ??= {};
  const wasm = env.backends.onnx.wasm;
  // numThreads=1: ORT создаёт воркер через blob:, который Bun/Node не
  // грузит ('no available backend found ... protocol blob:').
  wasm.numThreads = 1;
  wasm.proxy = false;
  wasm.wasmPaths = pathToFileURL(ortDir + '/').href;

  // Обход 4: web-сборка не умеет node:fs, поэтому файлы модели отдаются
  // через перехват fetch. Здесь же решается главная задача — подсунуть
  // вшитые в бинарь файлы вместо дисковых.
  const originalFetch = env.fetch ?? globalThis.fetch;
  env.fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? '');
    // Имя модели в URL — единственный надёжный признак: путь может быть
    // и относительным (/models/...), и абсолютным.
    const marker = 'multilingual-e5-small/';
    const idx = url.indexOf(marker);
    if (idx >= 0) {
      let rel = url.slice(idx + marker.length).split('?')[0] ?? '';
      // Разные сборки просят то model.onnx, то model_quantized.onnx.
      // Вшит квантованный (113 МБ против 449 МБ fp32), поэтому
      // перенаправляем запрос на него, а не отдаём 404.
      if (rel === 'onnx/model.onnx') rel = 'onnx/model_quantized.onnx';
      const embedded = EMBEDDER_FILES[rel];
      if (embedded) {
        const f = Bun.file(embedded);
        if (await f.exists()) {
          return new Response(await f.arrayBuffer(), { status: 200 });
        }
      }
      // Перенаправление на реальный путь для файлов, которых нет среди
      // вшитых: сюда попадают .wasm-части рантайма.
      // Явный 404 вместо тишины: Transformers.js сообщит, какого файла
      // не хватает, и причина будет видна сразу.
      return new Response(null, { status: 404 });
    }
    return originalFetch(input, init);
  };

  // 🔴 ONNX-сессия создаётся из ПУТИ, а не из буфера: loadResourceFile
  // с return_path=true требует FileResponse, которого в web-сборке нет
  // (класс отсутствует), а IS_NODE_ENV здесь ложен, потому что Bun — не
  // Node. Поэтому модель кладётся на диск и передаётся файлом.
  // Падало это как 'Unable to get model file path or buffer' — сообщение
  // указывало на модель, хотя причина в способе загрузки.
  const extractor = await pipeline('feature-extraction', MODEL_ID, {
    quantized: true,
    // web-сборка через статический импорт называет WASM-бэкенд 'cpu';
    // 'wasm' она отвергает: Unsupported device. При динамическом импорте
    // по абсолютному пути было наоборот — различие сборок, не опечатка.
    device: 'wasm',
  });

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
