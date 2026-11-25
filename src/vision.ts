// Florence-2: распознавание текста, таблиц и описание изображений.
//
// ЗАЧЕМ, КОГДА ЕСТЬ TESSERACT. Tesseract отдаёт ПЛОСКИЙ текст: колонки
// таблицы слипаются в кашу — на реальном PDF с рейсами получилось
// «115:2020:504h 30mNonstopRyanair». Florence-2 умеет структуру и, в
// отличие от tesseract, описывает изображения БЕЗ текста (схемы,
// графики, фотографии), где tesseract возвращает пустоту.
//
// ЦЕНА: 265 МБ в int8 (vision 89 + decoder 94 + encoder 42 + embed 38).
// Это АВТОРЕГРЕССИОННАЯ модель — она порождает текст токен за токеном,
// а не распознаёт за один проход. Замер той же архитектуры в этом
// проекте (whisper-base): 16.4 с на 3.7 с аудио, ×4.4 реального времени.
// Поэтому Florence-2 — не замена tesseract, а дополнение по требованию.
//
// Задачи задаются специальными токенами промпта — это не текст на
// естественном языке, а фиксированные метки, которые модель обучена
// распознавать.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { materializeOrt, materializeLib, FLORENCE_FILES } from './assets.ts';

/** Режимы Florence-2, применимые к нашей задаче. */
export type VisionTask =
  | 'ocr'           // просто текст
  | 'ocr_regions'   // текст с координатами блоков — основа для таблиц
  | 'caption'       // краткое описание изображения
  | 'caption_long'; // подробное описание

const PROMPTS: Record<VisionTask, string> = {
  ocr: '<OCR>',
  ocr_regions: '<OCR_WITH_REGION>',
  caption: '<CAPTION>',
  caption_long: '<MORE_DETAILED_CAPTION>',
};

const MODEL_ID = 'onnx-community/Florence-2-base';

export interface VisionResult {
  task: VisionTask;
  text: string;
  /** Блоки с координатами — только для ocr_regions. */
  regions?: Array<{ text: string; box: number[] }>;
}

let cached: unknown = null;

/**
 * Поднимает Florence-2.
 *
 * Обходы те же, что для эмбеддера: process.release прячется до импорта
 * (иначе библиотека выберет native-бэкенд, которого в musl нет),
 * numThreads=1 (воркер через blob: не грузится), wasmPaths как
 * file://-URL.
 */
async function loadModel(onProgress?: (n: string) => void): Promise<any> {
  if (cached) return cached;

  const ortDir = await materializeOrt();
  const libPath = await materializeLib();

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

  const { AutoProcessor, AutoTokenizer, Florence2ForConditionalGeneration, env } = lib;

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = '/models/';
  env.backends ??= {};
  env.backends.onnx ??= {};
  env.backends.onnx.wasm ??= {};
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.wasmPaths = pathToFileURL(ortDir + '/').href;

  // Файлы модели отдаются из вшитых ресурсов через перехват fetch
  const originalFetch = env.fetch ?? globalThis.fetch;
  env.fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? '');
    const marker = 'Florence-2-base/';
    const idx = url.indexOf(marker);
    if (idx >= 0) {
      const rel = url.slice(idx + marker.length).split('?')[0] ?? '';
      const embedded = FLORENCE_FILES[rel];
      if (embedded) {
        const f = Bun.file(embedded);
        if (await f.exists()) {
          return new Response(await f.arrayBuffer(), { status: 200 });
        }
      }
      return new Response(null, { status: 404 });
    }
    return originalFetch(input, init);
  };

  onProgress?.('загрузка Florence-2 (265 МБ, первый запуск дольше)');
  const [processor, tokenizer, model] = await Promise.all([
    AutoProcessor.from_pretrained(MODEL_ID),
    AutoTokenizer.from_pretrained(MODEL_ID),
    Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, {
      dtype: {
        embed_tokens: 'quantized',
        vision_encoder: 'quantized',
        encoder_model: 'quantized',
        decoder_model_merged: 'quantized',
      },
      device: 'wasm',
    }),
  ]);

  cached = { processor, tokenizer, model, lib };
  return cached;
}

/**
 * Прогоняет изображение через Florence-2.
 *
 * @param imagePath путь к файлу изображения
 * @param task какую задачу решать
 */
export async function runVision(
  imagePath: string,
  task: VisionTask = 'ocr',
  onProgress?: (n: string) => void,
): Promise<VisionResult> {
  const { processor, tokenizer, model, lib } = await loadModel(onProgress);
  const { RawImage } = lib;

  onProgress?.(`Florence-2: ${task}`);

  // 🔴 RawImage.fromURL в этой сборке падает с 'sharp_default is not a
  // function': библиотека импортирует sharp как CommonJS-модуль, а после
  // переписывания импортов на абсолютные пути (нужного для вшивания в
  // бинарь) интероп ломается. Поэтому изображение декодируется здесь
  // самостоятельно — заодно уходит нативная зависимость от sharp,
  // которую всё равно нельзя вшить в бинарь.
  const image = await decodeImage(imagePath, RawImage);
  const vision = await processor(image);

  const prompts = processor.construct_prompts(PROMPTS[task]);
  const textInputs = tokenizer(prompts);

  const generated = await model.generate({
    ...textInputs,
    ...vision,
    // 1024 хватает на страницу текста; больше — только дольше, а
    // Florence-2 и так медленный из-за авторегрессии
    max_new_tokens: 1024,
    num_beams: 1,
    do_sample: false,
  });

  const decoded = tokenizer.batch_decode(generated, { skip_special_tokens: false })[0] ?? '';
  const parsed = processor.post_process_generation(
    decoded, PROMPTS[task], image.size,
  );

  const payload = parsed[PROMPTS[task]];

  if (task === 'ocr_regions' && payload && typeof payload === 'object') {
    const labels: string[] = payload.labels ?? [];
    const boxes: number[][] = payload.quad_boxes ?? payload.bboxes ?? [];
    return {
      task,
      text: labels.join('\n'),
      regions: labels.map((t, i) => ({ text: t, box: boxes[i] ?? [] })),
    };
  }

  return { task, text: typeof payload === 'string' ? payload.trim() : String(payload ?? '') };
}

/**
 * Декодирует изображение в RawImage через системный ImageMagick.
 *
 * Возвращается сырой RGB: формат, который RawImage принимает напрямую.
 * magick уже требуется для подготовки иконок и есть в большинстве
 * систем; при его отсутствии будет понятная ошибка, а не падение внутри
 * чужой библиотеки.
 */
async function decodeImage(path: string, RawImage: any, size = 768): Promise<any> {
  // Изображение приводится к нужному размеру ЗДЕСЬ, а не в процессоре
  // библиотеки: тот вызывает sharp для resize, и интероп снова ломается.
  // Растягиваем принудительно (знак !), потому что Florence-2 обучен на
  // квадратном входе 768x768 и сам пропорции не восстанавливает.
  const proc = Bun.spawn(
    ['magick', path, '-strip', '-colorspace', 'sRGB',
     '-resize', `${size}x${size}!`, '-depth', '8', 'rgb:-'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const raw = Buffer.from(await new Response(proc.stdout).arrayBuffer());
  if ((await proc.exited) !== 0 || raw.length === 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`не удалось прочитать изображение ${path}: ${err.slice(0, 120)}`);
  }

  // Контроль: длина буфера обязана совпасть с size*size*3, иначе
  // раскладка каналов поедет и модель получит мусор
  const expected = size * size * 3;
  if (raw.length !== expected) {
    throw new Error(`размер данных ${raw.length} != ожидаемого ${expected}`);
  }

  return new RawImage(new Uint8ClampedArray(raw), size, size, 3);
}

/** Выгружает модель из памяти: 265 МБ держать между командами незачем. */
export function unloadVision(): void {
  cached = null;
}
