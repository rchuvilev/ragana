import { test, expect } from 'bun:test';
import { EmbeddingCache, withCache } from '../src/cache.ts';
import { unlinkSync } from 'node:fs';

const tmpDb = () => `/tmp/ragana-cache-${Math.random().toString(36).slice(2)}.sqlite`;

const vec = (seed: number, dim = 4) =>
  Float32Array.from({ length: dim }, (_, i) => (seed + i) / 10);

test('промах, затем попадание', () => {
  const f = tmpDb();
  const c = new EmbeddingCache(f, 'e5', 4);
  expect(c.get('текст')).toBeNull();
  c.put('текст', vec(1));
  const got = c.get('текст');
  expect(got).not.toBeNull();
  expect(Array.from(got!)).toEqual(Array.from(vec(1)));
  c.close(); unlinkSync(f);
});

test('🔴 смена модели ИНВАЛИДИРУЕТ кэш', () => {
  // Без этого векторы из разных пространств попали бы в один индекс и
  // тихо сломали ранжирование — отказ был бы незаметным.
  const f = tmpDb();
  const a = new EmbeddingCache(f, 'e5-small', 4);
  a.put('текст', vec(1));
  expect(a.get('текст')).not.toBeNull();
  a.close();

  const b = new EmbeddingCache(f, 'e5-large', 4);
  expect(b.get('текст')).toBeNull();
  b.close(); unlinkSync(f);
});

test('смена размерности тоже инвалидирует', () => {
  const f = tmpDb();
  const a = new EmbeddingCache(f, 'e5', 4);
  a.put('текст', vec(1));
  a.close();
  const b = new EmbeddingCache(f, 'e5', 384);
  expect(b.get('текст')).toBeNull();
  b.close(); unlinkSync(f);
});

test('кэш переживает закрытие процесса', () => {
  const f = tmpDb();
  const a = new EmbeddingCache(f, 'e5', 4);
  a.put('устойчивый', vec(7));
  a.close();

  const b = new EmbeddingCache(f, 'e5', 4);
  expect(Array.from(b.get('устойчивый')!)).toEqual(Array.from(vec(7)));
  b.close(); unlinkSync(f);
});

test('статистика считает попадания', () => {
  const f = tmpDb();
  const c = new EmbeddingCache(f, 'e5', 4);
  c.get('нет');          // промах
  c.put('есть', vec(1));
  c.get('есть');         // попадание
  c.get('есть');         // попадание
  const s = c.getStats();
  expect(s.hits).toBe(2);
  expect(s.misses).toBe(1);
  expect(s.hitRate).toBeCloseTo(2 / 3, 3);
  c.close(); unlinkSync(f);
});

test('prune вытесняет наименее используемые', () => {
  const f = tmpDb();
  const c = new EmbeddingCache(f, 'e5', 4);
  for (let i = 0; i < 10; i++) c.put(`t${i}`, vec(i));
  // поднимаем частоту у двух
  c.get('t5'); c.get('t5'); c.get('t7');
  const removed = c.prune(3);
  expect(removed).toBe(7);
  // часто используемые обязаны уцелеть
  expect(c.get('t5')).not.toBeNull();
  c.close(); unlinkSync(f);
});

test('prune ничего не делает, когда лимит не достигнут', () => {
  const f = tmpDb();
  const c = new EmbeddingCache(f, 'e5', 4);
  c.put('a', vec(1));
  expect(c.prune(100)).toBe(0);
  expect(c.get('a')).not.toBeNull();
  c.close(); unlinkSync(f);
});

test('🟢 withCache: модель вызывается ТОЛЬКО для промахов', async () => {
  const f = tmpDb();
  const c = new EmbeddingCache(f, 'e5', 4);
  const seen: string[][] = [];
  const base = {
    dim: 4,
    async embed(texts: string[]) {
      seen.push([...texts]);
      return texts.map((_, i) => vec(i));
    },
  };
  const wrapped = withCache(base, c);

  await wrapped.embed(['a', 'b']);
  expect(seen[0]).toEqual(['a', 'b']);

  // второй заход: оба известны — модель не должна вызываться вовсе
  await wrapped.embed(['a', 'b']);
  expect(seen.length).toBe(1);

  // смешанный: модель получает ТОЛЬКО новое, пачка остаётся плотной
  await wrapped.embed(['a', 'c', 'b', 'd']);
  expect(seen[1]).toEqual(['c', 'd']);

  c.close(); unlinkSync(f);
});

test('🟢 withCache сохраняет ПОРЯДОК при смешанных попаданиях', async () => {
  const f = tmpDb();
  const c = new EmbeddingCache(f, 'e5', 4);
  const base = {
    dim: 4,
    // по первому символу, чтобы результат был опознаваем
    async embed(texts: string[]) {
      return texts.map((t) => Float32Array.from([t.charCodeAt(0), 0, 0, 0]));
    },
  };
  const w = withCache(base, c);
  await w.embed(['b']);                       // кладём 'b' в кэш
  const out = await w.embed(['a', 'b', 'c']); // 'b' из кэша, остальные новые
  expect(out.map((v) => v[0])).toEqual([97, 98, 99]);
  c.close(); unlinkSync(f);
});

test('withCache на пустом входе не падает', async () => {
  const f = tmpDb();
  const c = new EmbeddingCache(f, 'e5', 4);
  const w = withCache({ dim: 4, embed: async () => [] }, c);
  expect(await w.embed([])).toEqual([]);
  c.close(); unlinkSync(f);
});
