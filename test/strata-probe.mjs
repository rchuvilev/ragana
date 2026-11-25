// Применимы ли идеи Strata к ragana? Проверяем ЗАМЕРОМ, а не рассуждением.
//
// Strata решает: модель 94 ГБ не влезает в 12-24 ГБ VRAM. Приёмы:
//   1. адаптивный кэш «горячего» по частоте использования
//   2. параллельная работа GPU и CPU вместо ожидания
//   3. spec-decoding (черновик + проверка) — только для генерации
//   4. чтение большими кусками (8192 токена за раз)
//
// У нас другая задача: модель 113 МБ влезает целиком. Значит прямого
// переноса нет. Но три вопроса стоит проверить:
//   A. сколько стоит ПОВТОРНАЯ загрузка модели между запусками CLI
//   B. даёт ли батчинг выигрыш (аналог «чтения большими кусками»)
//   C. сколько в реальном корпусе ПОВТОРЯЮЩИХСЯ текстов (кэш по хэшу)

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CWD = '/var/minis/repos/ragana';
const MODEL = join(CWD, 'models/multilingual-e5-small');

async function makeEmbedder(numThreads) {
  const libPath = join(CWD, 'node_modules/@huggingface/transformers/dist/transformers.web.js');
  const saved = process.release;
  delete process.release;
  let lib;
  try { lib = await import(libPath); } finally { process.release = saved; }
  const { pipeline, env } = lib;

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.backends.onnx.wasm.numThreads = numThreads;
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.wasmPaths = pathToFileURL(
    join(CWD, 'node_modules/onnxruntime-web/dist/'),
  ).href;

  const { readFile } = await import('node:fs/promises');
  const originalFetch = env.fetch ?? globalThis.fetch;
  env.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? '');
    const i = url.indexOf('multilingual-e5-small/');
    if (i >= 0) {
      const rel = url.slice(i + 'multilingual-e5-small/'.length).split('?')[0];
      try { return new Response(await readFile(join(MODEL, rel)), { status: 200 }); }
      catch { return new Response(null, { status: 404 }); }
    }
    return originalFetch(input, init);
  };

  return pipeline('feature-extraction', 'Xenova/multilingual-e5-small', {
    quantized: true, device: 'wasm',
  });
}

const texts = Array.from({ length: 32 }, (_, i) =>
  `passage: Фрагмент номер ${i} про страховой случай, франшизу и порядок выплаты возмещения.`);

console.log('=== A. СТОИМОСТЬ ЗАГРУЗКИ МОДЕЛИ (главная цель кэширования)');
const t0 = Date.now();
const ex = await makeEmbedder(1);
const loadMs = Date.now() - t0;
console.log(`   загрузка: ${(loadMs / 1000).toFixed(1)} с`);

// прогрев
await ex(['query: прогрев'], { pooling: 'mean', normalize: true });

console.log('\n=== B. БАТЧИНГ: даёт ли выигрыш обработка пачкой');
console.log('   размер | всего мс | мс/текст');
for (const batch of [1, 2, 4, 8, 16, 32]) {
  const slice = texts.slice(0, batch);
  const t = Date.now();
  await ex(slice, { pooling: 'mean', normalize: true });
  const ms = Date.now() - t;
  console.log(`   ${String(batch).padStart(6)} | ${String(ms).padStart(8)} | ${(ms / batch).toFixed(0).padStart(8)}`);
}

console.log('\n=== C. ПОТОКИ: numThreads>1 в Node');
for (const th of [1, 2, 4]) {
  try {
    const e2 = await makeEmbedder(th);
    await e2(['query: прогрев'], { pooling: 'mean', normalize: true });
    const t = Date.now();
    await e2(texts.slice(0, 8), { pooling: 'mean', normalize: true });
    console.log(`   threads=${th}: ${Date.now() - t} мс на 8 текстов`);
  } catch (e) {
    console.log(`   threads=${th}: ОШИБКА ${String(e.message).slice(0, 60)}`);
  }
}

console.log(`\nВЫВОД: загрузка ${(loadMs / 1000).toFixed(1)} с — это столько же,`);
console.log(`сколько ${Math.round(loadMs / 205)} эмбеддингов. Для CLI, который`);
console.log('запускается на каждый поиск, это доминирующая стоимость.');
