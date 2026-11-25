// Ресурсы, вшитые в исполняемый файл.
//
// `import x from './file' with { type: 'file' }` заставляет bun build
// --compile положить файл ВНУТРЬ бинаря, а при работе вернуть путь в
// виртуальной файловой системе /$bunfs/root/.
//
// ПРОВЕРЕНО СТРОГИМ КОНТРОЛЕМ: модель 113 МБ читается из бинаря даже
// после того, как исходный .onnx УБРАН С ДИСКА. То есть это настоящее
// вшивание, а не ссылка на файл рядом.
//   пустой бинарь          75.5 МБ
//   + модель e5 (113 МБ)   184.8 МБ
//
// В режиме разработки (bun run src/main.ts) те же импорты отдают обычные
// пути к файлам на диске, так что код один и тот же.

import onnxModel from '../models/multilingual-e5-small/onnx/model_quantized.onnx' with { type: 'file' };
import modelConfig from '../models/multilingual-e5-small/config.json' with { type: 'file' };
import tokenizer from '../models/multilingual-e5-small/tokenizer.json' with { type: 'file' };
import tokenizerConfig from '../models/multilingual-e5-small/tokenizer_config.json' with { type: 'file' };
import specialTokens from '../models/multilingual-e5-small/special_tokens_map.json' with { type: 'file' };

// Florence-2: распознавание таблиц и описание изображений.
// 265 МБ в четырёх частях — это авторегрессионная модель, работающая
// заметно медленнее tesseract, поэтому применяется по требованию
// (--ocr florence), а не вместо него.
import flVision from '../models/florence-2-base/onnx/vision_encoder_quantized.onnx' with { type: 'file' };
import flDecoder from '../models/florence-2-base/onnx/decoder_model_merged_quantized.onnx' with { type: 'file' };
import flEncoder from '../models/florence-2-base/onnx/encoder_model_quantized.onnx' with { type: 'file' };
import flEmbed from '../models/florence-2-base/onnx/embed_tokens_quantized.onnx' with { type: 'file' };
import flConfig from '../models/florence-2-base/config.json' with { type: 'file' };
import flGenConfig from '../models/florence-2-base/generation_config.json' with { type: 'file' };
import flPreproc from '../models/florence-2-base/preprocessor_config.json' with { type: 'file' };
import flTokenizer from '../models/florence-2-base/tokenizer.json' with { type: 'file' };
import flTokenizerCfg from '../models/florence-2-base/tokenizer_config.json' with { type: 'file' };

// WASM-рантайм ONNX. Вшивается как ФАЙЛ, потому что onnxruntime-web
// загружает его по пути во время работы, а не импортом — статический
// импорт его не втянул бы.
// 🔴 Нужен именно .jsep.-вариант: ort.bundle.min.mjs, который тянет
// Transformers.js, ищет ort-wasm-simd-threaded.jsep.wasm. Базовый
// ort-wasm-simd-threaded.wasm разложен рядом, но ORT его не искал — и
// падение выглядело как 'Unable to get model file path or buffer', то
// есть указывало на модель, а не на рантайм.
import ortJsepWasm from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm' with { type: 'file' };
import ortJsepMjs from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs' with { type: 'file' };
import ortAsyncWasm from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm' with { type: 'file' };
import ortAsyncMjs from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs' with { type: 'file' };

/**
 * Файлы модели эмбеддингов.
 *
 * Ключ — путь, по которому Transformers.js будет их запрашивать
 * относительно каталога модели. Значение — реальный путь (в бинаре это
 * /$bunfs/..., в разработке — обычный файл).
 */
export const EMBEDDER_FILES: Record<string, string> = {
  'onnx/model_quantized.onnx': onnxModel,
  'config.json': modelConfig,
  'tokenizer.json': tokenizer,
  'tokenizer_config.json': tokenizerConfig,
  'special_tokens_map.json': specialTokens,
};

// JS-библиотеки как ФАЙЛЫ: статический импорт web-сборки ломается
// (пустая ветка IS_NODE_ENV && return_path), поэтому она грузится
// динамически — но сам файл вшивается и раскладывается рядом с ORT,
// чтобы бинарь не зависел от node_modules на диске.
import libTransformers from '../node_modules/@huggingface/transformers/dist/transformers.web.js' with { type: 'file' };
import libOrt from '../node_modules/onnxruntime-web/dist/ort.bundle.min.mjs' with { type: 'file' };
import libOrtWebgpu from '../node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs' with { type: 'file' };
// onnxruntime-common состоит из 21 модуля с относительными импортами,
// поэтому он предварительно собирается в ОДИН файл (tools/vendor.sh):
// копировать 21 файл и чинить пути внутри каждого — хрупко.
import libOrtCommon from '../vendor/ort-common.mjs' with { type: 'file' };

/** Файлы Florence-2 — ключи совпадают с запрашиваемыми путями. */
export const FLORENCE_FILES: Record<string, string> = {
  'onnx/vision_encoder_quantized.onnx': flVision,
  'onnx/decoder_model_merged_quantized.onnx': flDecoder,
  'onnx/encoder_model_quantized.onnx': flEncoder,
  'onnx/embed_tokens_quantized.onnx': flEmbed,
  'config.json': flConfig,
  'generation_config.json': flGenConfig,
  'preprocessor_config.json': flPreproc,
  'tokenizer.json': flTokenizer,
  'tokenizer_config.json': flTokenizerCfg,
};

/**
 * Файлы рантайма ONNX.
 *
 * ORT ищет их в каталоге wasmPaths по ИМЕНАМ, поэтому при запуске их
 * надо разложить во временный каталог: виртуальная ФС /$bunfs/ даёт
 * пути с хэшами в имени, и ORT по ним не найдёт.
 */
export const ORT_FILES: Record<string, string> = {
  // Какой вариант затребует ORT, зависит от того, какая его сборка
  // окажется загруженной (ort.bundle vs ort.webgpu.bundle), а это решает
  // сама библиотека. Раскладываем оба: лишние 40 МБ в бинаре дешевле,
  // чем падение 'no available backend found' на чужой машине.
  'ort-wasm-simd-threaded.jsep.wasm': ortJsepWasm,
  'ort-wasm-simd-threaded.jsep.mjs': ortJsepMjs,
  'ort-wasm-simd-threaded.asyncify.wasm': ortAsyncWasm,
  'ort-wasm-simd-threaded.asyncify.mjs': ortAsyncMjs,
};

/**
 * Раскладывает рантайм ONNX во временный каталог и возвращает его путь.
 *
 * Идемпотентно: если файлы уже разложены и совпадают по размеру,
 * повторная запись пропускается — при каждом запуске CLI копировать
 * 13.6 МБ было бы заметной задержкой.
 */
export async function materializeOrt(): Promise<string> {
  const { tmpdir } = await import('node:os');
  const { mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const dir = join(tmpdir(), 'ragana-ort');
  await mkdir(dir, { recursive: true });

  for (const [name, src] of Object.entries(ORT_FILES)) {
    const dest = join(dir, name);
    const srcFile = Bun.file(src);
    const destFile = Bun.file(dest);
    if (await destFile.exists() && destFile.size === srcFile.size) continue;
    await Bun.write(dest, srcFile);
  }
  return dir;
}

/**
 * Раскладывает библиотеки так, чтобы динамический импорт нашёл их без
 * node_modules на диске.
 *
 * Раскладка повторяет структуру node_modules, потому что
 * transformers.web.js импортирует 'onnxruntime-web' по ИМЕНИ ПАКЕТА, а
 * резолвер ищет его в ближайшем node_modules вверх по дереву.
 * Возвращает путь к самой transformers.web.js.
 */
export async function materializeLib(): Promise<string> {
  const { tmpdir } = await import('node:os');
  const { mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const base = join(tmpdir(), 'ragana-lib');
  const hfDist = join(base, 'hf');
  const ortDist = join(base, 'ort');
  const commonDir = join(base, 'common');
  await mkdir(hfDist, { recursive: true });
  await mkdir(ortDist, { recursive: true });
  await mkdir(commonDir, { recursive: true });

  const commonPath = join(commonDir, 'index.js');
  const copies: Array<[string, string]> = [
    [join(hfDist, 'transformers.web.js'), libTransformers],
    [join(ortDist, 'ort.bundle.min.mjs'), libOrt],
    [join(ortDist, 'ort.webgpu.bundle.min.mjs'), libOrtWebgpu],
    [commonPath, libOrtCommon],
    ...Object.entries(ORT_FILES).map(
      ([name, src]) => [join(ortDist, name), src] as [string, string],
    ),
  ];
  for (const [dest, src] of copies) {
    const srcFile = Bun.file(src);
    const destFile = Bun.file(dest);
    if (await destFile.exists() && destFile.size === srcFile.size) continue;
    await Bun.write(dest, srcFile);
  }

  // 🔴 Резолвер Bun НЕ находит пакеты по имени во временном каталоге,
  // даже при корректной раскладке node_modules с манифестами. Поэтому
  // импорты по именам переписываются на АБСОЛЮТНЫЕ ПУТИ — единственное,
  // что работает независимо от расположения файлов.
  //
  // Порядок важен: сначала чинится ORT (он тянет onnxruntime-common),
  // и только потом transformers, который должен ссылаться уже на
  // ИСПРАВЛЕННЫЕ файлы ORT, а не на исходные.
  const patch = async (src: string, dst: string, map: Array<[string, string]>) => {
    if (await Bun.file(dst).exists()) return;
    let code = await Bun.file(src).text();
    for (const [name, path] of map) {
      code = code
        .replaceAll(`"${name}"`, JSON.stringify(path))
        .replaceAll(`'${name}'`, JSON.stringify(path));
    }
    await Bun.write(dst, code);
  };

  const ortFixed = join(ortDist, 'ort.fixed.mjs');
  const webgpuFixed = join(ortDist, 'ort.webgpu.fixed.mjs');
  await patch(join(ortDist, 'ort.bundle.min.mjs'), ortFixed,
    [['onnxruntime-common', commonPath]]);
  await patch(join(ortDist, 'ort.webgpu.bundle.min.mjs'), webgpuFixed,
    [['onnxruntime-common', commonPath]]);

  // transformers импортирует onnxruntime-common НАПРЯМУЮ, помимо ORT —
  // проверено grep'ом по сборке. Без этой строки бинарь падал с
  // 'Cannot find package onnxruntime-common' только после того, как
  // node_modules убирали с диска: при наличии каталога резолвер находил
  // пакет, и дефект был невидим.
  const hfFixed = join(hfDist, 'transformers.fixed.mjs');
  await patch(join(hfDist, 'transformers.web.js'), hfFixed, [
    ['onnxruntime-web/webgpu', webgpuFixed],
    ['onnxruntime-web', ortFixed],
    ['onnxruntime-common', commonPath],
  ]);

  return hfFixed;
}

/** Работаем ли изнутри скомпилированного бинаря. */
export function isCompiled(): boolean {
  return EMBEDDER_FILES['config.json']!.startsWith('/$bunfs/');
}

/**
 * Отдаёт содержимое файла модели по относительному пути.
 * Возвращает null, если такого файла нет — вызывающий обязан это
 * обработать, а не получить пустой буфер и гадать.
 */
export async function readEmbedderFile(rel: string): Promise<Uint8Array | null> {
  const path = EMBEDDER_FILES[rel];
  if (!path) return null;
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return new Uint8Array(await file.arrayBuffer());
}

/** Сводка для диагностики: что вшито и сколько весит. */
export async function assetReport(): Promise<Array<{ name: string; bytes: number }>> {
  const out: Array<{ name: string; bytes: number }> = [];
  for (const [name, path] of Object.entries(EMBEDDER_FILES)) {
    const f = Bun.file(path);
    out.push({ name, bytes: (await f.exists()) ? f.size : 0 });
  }
  return out;
}
