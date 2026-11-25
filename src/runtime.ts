// Единая точка загрузки Transformers.js.
//
// 🔴 ЭТОТ МОДУЛЬ УСТРАНЯЕТ ТРОЙНОЕ ДУБЛИРОВАНИЕ. Один и тот же набор из
// четырёх обходов был скопирован в asr.ts, embedder.ts и vision.ts — то
// есть ошибку в нём пришлось бы править в трёх местах, а расхождение
// между копиями проявилось бы только в бою.
//
// ЧЕТЫРЕ ОБХОДА ДЛЯ ALPINE/MUSL (каждый проверен отказом):
//
// 1. native onnxruntime-node НЕ ЛИНКУЕТСЯ:
//      Error relocating libonnxruntime.so.1: __getauxval: symbol not found
//    Это glibc-символ, здесь musl. Отсюда web-сборка вместо node-сборки.
//
// 2. СТАТИЧЕСКИЙ ИМПОРТ web-сборки НЕПРИГОДЕН: при IS_NODE_ENV &&
//    return_path в loadResourceFile стоит ПУСТАЯ ветка
//    (transformers.web.js:7578), result остаётся undefined, и всё падает
//    с 'Unable to get model file path or buffer' — сообщение указывает на
//    модель, хотя причина в способе загрузки.
//
// 3. IS_NODE_ENV вычисляется ОДИН РАЗ при инициализации модуля из
//    process.release.name, подменить его после импорта нельзя. Поэтому
//    process.release прячется ДО динамического импорта.
//    ⚠️ Глобальный Symbol.for('onnxruntime') НЕ годится: он минует блок,
//    заполняющий supportedDevices, и даёт «Unsupported device: wasm».
//
// 4. numThreads=1 обязателен: ORT создаёт воркер через blob:-URL, который
//    Bun и Node не грузят ('no available backend found ... protocol
//    blob:'). В БРАУЗЕРЕ наоборот — там blob: работает и потоки ускоряют.
//
// 5. wasmPaths ДОЛЖЕН быть file://-URL, а не путём: иначе загрузчик
//    трактует его как https: и уходит за wasm на CDN.

import { pathToFileURL } from 'node:url';
import { materializeOrt, materializeLib } from './assets.ts';

/** Загруженная библиотека со всеми нужными классами. */
export interface Transformers {
  pipeline: (task: string, model: string, opts?: unknown) => Promise<unknown>;
  env: Record<string, never> & Record<string, unknown>;
  AutoProcessor: { from_pretrained: (id: string, o?: unknown) => Promise<unknown> };
  AutoTokenizer: { from_pretrained: (id: string, o?: unknown) => Promise<unknown> };
  Florence2ForConditionalGeneration: {
    from_pretrained: (id: string, o?: unknown) => Promise<unknown>;
  };
  RawImage: new (data: Uint8ClampedArray, w: number, h: number, c: number) => unknown;
  [key: string]: unknown;
}

/** Кэш: библиотека грузится один раз на процесс. */
let cached: Transformers | null = null;

/**
 * Поднимает Transformers.js со всеми обходами.
 *
 * Возвращает одну и ту же библиотеку при повторных вызовах: её
 * инициализация занимает заметное время, а env — глобальный объект, и
 * повторная настройка затирала бы предыдущую.
 */
export async function loadTransformers(): Promise<Transformers> {
  if (cached) return cached;

  const ortDir = await materializeOrt();
  const libPath = await materializeLib();

  // Обход 3: прячем process.release ДО импорта
  const savedRelease = process.release;
  // @ts-expect-error намеренная временная подмена
  delete process.release;
  let lib: Transformers;
  try {
    lib = (await import(libPath)) as Transformers;
  } finally {
    // @ts-expect-error возвращаем на место
    process.release = savedRelease;
  }

  const env = lib.env as Record<string, any>;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = '/models/';

  // env.backends.onnx.wasm создаётся ЛЕНИВО: при обращении до
  // инициализации было 'undefined is not an object'
  env.backends ??= {};
  env.backends.onnx ??= {};
  env.backends.onnx.wasm ??= {};
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.wasmPaths = pathToFileURL(ortDir + '/').href;

  // ⚠️ useFS НЕ включать: web-сборка не линкует node:fs, попытка даёт
  // 'node_fs_default.existsSync is not a function'
  env.useFS = false;

  cached = lib;
  return lib;
}

/**
 * Перехватывает загрузку файлов модели, отдавая вшитые в бинарь.
 *
 * Вызывается ПОСЛЕ loadTransformers и ДО создания модели. Перехватчики
 * складываются: каждая модель регистрирует свой набор файлов, и запрос
 * уходит дальше по цепочке, если текущий его не узнал.
 *
 * @param lib библиотека от loadTransformers
 * @param marker часть URL, по которой узнаётся модель ('Florence-2-base/')
 * @param files относительный путь -> реальный путь к файлу
 * @param aliases подстановка имён: разные сборки просят model.onnx либо
 *        model_quantized.onnx
 */
export function serveModelFiles(
  lib: Transformers,
  marker: string,
  files: Record<string, string>,
  aliases: Record<string, string> = {},
): void {
  const env = lib.env as Record<string, any>;
  const previous = env.fetch ?? globalThis.fetch;

  env.fetch = async (input: unknown, init?: unknown): Promise<Response> => {
    const url = typeof input === 'string'
      ? input
      : String((input as { url?: string })?.url ?? '');
    const idx = url.indexOf(marker);

    if (idx >= 0) {
      let rel = url.slice(idx + marker.length).split('?')[0] ?? '';
      rel = aliases[rel] ?? rel;
      const embedded = files[rel];
      if (embedded) {
        const file = Bun.file(embedded);
        if (await file.exists()) {
          return new Response(await file.arrayBuffer(), { status: 200 });
        }
      }
      // Явный 404 вместо тишины: библиотека сообщит, какого файла не
      // хватает, и причина будет видна сразу
      return new Response(null, { status: 404 });
    }

    return previous(input, init);
  };
}

/** Сбрасывает кэш — нужно только тестам. */
export function resetRuntime(): void {
  cached = null;
}
