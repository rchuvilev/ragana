import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { sqliteKv } from '../src/sqlite-kv.ts';
import { EmbedCache, withEmbedCache } from '../core/embed-cache.mjs';
import { Cooc } from '../core/cooc.mjs';

// ТРЕТЬЯ реализация KvStore (наряду с memoryKv и indexedDbKv) проверяется
// ТЕМ ЖЕ контрактом. Иначе расхождение обнаружилось бы в бою: логика
// cooc и embed-cache написана один раз и опирается на этот контракт.

const kv = () => sqliteKv(new Database(':memory:'));
const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array | null) => new TextDecoder().decode(b ?? new Uint8Array());

test('[sqlite] запись и чтение', async () => {
  const s = kv();
  expect(await s.get('нет')).toBeNull();
  await s.set('a', bytes('значение'));
  expect(str(await s.get('a'))).toBe('значение');
});

test('[sqlite] перезапись и удаление', async () => {
  const s = kv();
  await s.set('a', bytes('первое'));
  await s.set('a', bytes('второе'));
  expect(str(await s.get('a'))).toBe('второе');
  await s.delete('a');
  expect(await s.get('a')).toBeNull();
  // Удаление несуществующего не должно падать
  await s.delete('нет-такого');
});

test('[sqlite] обход по префиксу', async () => {
  const s = kv();
  await s.set('p:1', bytes('1'));
  await s.set('p:2', bytes('2'));
  await s.set('q:1', bytes('3'));

  const found: string[] = [];
  for await (const [k] of s.scan('p:')) found.push(k);
  expect(found.sort()).toEqual(['p:1', 'p:2']);
});

test('[sqlite] 🔴 префикс НЕ захватывает чужие ключи', async () => {
  const s = kv();
  await s.set('ab', bytes('1'));
  await s.set('abc', bytes('2'));
  await s.set('b', bytes('3'));

  const keys: string[] = [];
  for await (const [k] of s.scan('ab')) keys.push(k);
  expect(keys.sort()).toEqual(['ab', 'abc']);
});

test('[sqlite] 🔴 спецсимволы LIKE экранируются', async () => {
  // Без ESCAPE префикс «a%» совпал бы со ВСЕМ, начинающимся на «a»,
  // потому что % в LIKE — подстановочный знак. Тихая ошибка: обход
  // возвращал бы лишнее, и кэш отдавал бы чужие векторы.
  const s = kv();
  await s.set('a%x', bytes('1'));
  await s.set('abc', bytes('2'));
  await s.set('a_y', bytes('3'));

  const pct: string[] = [];
  for await (const [k] of s.scan('a%')) pct.push(k);
  expect(pct).toEqual(['a%x']);

  const under: string[] = [];
  for await (const [k] of s.scan('a_')) under.push(k);
  expect(under).toEqual(['a_y']);
});

test('[sqlite] подсчёт и очистка по префиксу', async () => {
  const s = kv();
  await s.set('p:1', bytes('a'));
  await s.set('p:2', bytes('b'));
  await s.set('q:1', bytes('c'));
  expect(await s.count()).toBe(3);
  expect(await s.count('p:')).toBe(2);

  await s.clear('p:');
  expect(await s.count()).toBe(1);
  expect(str(await s.get('q:1'))).toBe('c');

  await s.clear();
  expect(await s.count()).toBe(0);
});

test('🟢 [sqlite] кэш эмбеддингов работает на этой реализации', async () => {
  const cache = new EmbedCache(kv(), 'e5', 4);
  const v = Float32Array.from([0.1, -0.5, 0.75, 1]);
  await cache.put('текст', v);
  const back = await cache.get('текст');
  expect(back).not.toBeNull();
  for (let i = 0; i < 4; i++) {
    expect(Math.abs(back![i]! - v[i]!)).toBeLessThan(1e-6);
  }
});

test('🟢 [sqlite] withEmbedCache зовёт модель только для промахов', async () => {
  const cache = new EmbedCache(kv(), 'e5', 4);
  const seen: string[][] = [];
  const w = withEmbedCache({
    dim: 4,
    async embed(texts: string[]) {
      seen.push([...texts]);
      return texts.map((t) => Float32Array.from([t.charCodeAt(0), 0, 0, 0]));
    },
  }, cache);

  await w.embed(['a', 'b']);
  const out = await w.embed(['a', 'c', 'b']);
  expect(seen[1]).toEqual(['c']);
  expect(out.map((x) => x[0])).toEqual([97, 99, 98]);
});

test('🟢 [sqlite] словарь совместной встречаемости работает', async () => {
  const c = new Cooc(kv());
  for (let i = 0; i < 5; i++) {
    c.add('Ипотека оформляется по ставке банка с досрочным погашением');
  }
  for (let i = 0; i < 4; i++) {
    c.add('Гарантия распространяется на ремонт оборудования');
  }
  await c.flush();

  const rel = (await c.related('ипотека', 10)).map((r) => r.term);
  expect(rel.some((t) => t.startsWith('ставк'))).toBe(true);
  // контроль: чужой контекст не подмешивается
  expect(rel.some((t) => t.startsWith('гарант'))).toBe(false);
});
