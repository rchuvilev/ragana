// Замер, оправдывающий отказ от HNSW. Утверждение к проверке:
// поиск перебором пренебрежимо мал на фоне ~438 мс эмбеддинга запроса.
import { VectorStore, DIM } from '../core/vector.mjs';

const EMBED_MS = 438; // замер 2026-11-22, multilingual-e5-small на этом телефоне

const rnd = (seed) => {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
};

console.log(`размерность ${DIM}, эмбеддинг запроса = ${EMBED_MS} мс (измерено)\n`);
console.log('чанков |  RAM   | поиск k=5 | доля от запроса');
console.log('-------|--------|-----------|----------------');

for (const n of [1000, 5000, 20000, 50000]) {
  const vs = new VectorStore(DIM, n);
  const r = rnd(42);
  const tmp = new Float32Array(DIM);
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < DIM; d++) tmp[d] = r();
    vs.add(`c${i}`, tmp);
  }
  const q = Float32Array.from({ length: DIM }, r);

  for (let i = 0; i < 5; i++) vs.search(q, 5); // прогрев JIT

  const runs = 20;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) vs.search(q, 5);
  const ms = (performance.now() - t0) / runs;

  const mb = (n * DIM * 4) / 1048576;
  const pct = (ms / (EMBED_MS + ms)) * 100;
  console.log(
    `${String(n).padStart(6)} | ${mb.toFixed(1).padStart(5)}М | ` +
    `${ms.toFixed(2).padStart(7)} мс | ${pct.toFixed(2).padStart(6)}%`,
  );
}

console.log('\nВывод: пока доля заметно меньше 50%, индекс оптимизирует не то.');
