// Вопрос: можно ли хэшировать ВСЁ при каждом снимке, или нужен
// дешёвый предфильтр? Меряем пропускную способность на этом телефоне.
import { createHash, webcrypto } from 'node:crypto';

const MB = 1048576;
const buf = Buffer.alloc(8 * MB);
for (let i = 0; i < buf.length; i++) buf[i] = (i * 2654435761) & 0xff;

async function bench(name, fn) {
  await fn(buf.subarray(0, MB)); // прогрев
  const t0 = performance.now();
  await fn(buf);
  const ms = performance.now() - t0;
  const mbps = (buf.length / MB) / (ms / 1000);
  console.log(`${name.padEnd(22)} ${ms.toFixed(0).padStart(6)} мс  ${mbps.toFixed(0).padStart(5)} МБ/с`);
  return mbps;
}

console.log('Хэширование 8 МБ, Snapdragon 732G / Node ' + process.version + '\n');

const sha256 = await bench('node sha256', async (b) =>
  createHash('sha256').update(b).digest());
const sha1 = await bench('node sha1', async (b) =>
  createHash('sha1').update(b).digest());
const wc = await bench('WebCrypto SHA-256', async (b) =>
  webcrypto.subtle.digest('SHA-256', b));

// FNV-1a на JS — то, что доступно без WebCrypto в синхронном коде
const fnv = await bench('FNV-1a (чистый JS)', async (b) => {
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
});

console.log('\n--- Сколько займёт полный снимок через WebCrypto:');
for (const [n, sz] of [['500 файлов × 200 КБ', 500 * 0.2], ['2000 × 500 КБ', 2000 * 0.5], ['5000 × 1 МБ', 5000]]) {
  console.log(`  ${n.padEnd(22)} = ${String(sz).padStart(5)} МБ -> ${(sz / wc).toFixed(1)} с`);
}
