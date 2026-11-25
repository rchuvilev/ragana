import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange as KR } from 'fake-indexeddb';
import { EmbedCache, withEmbedCache } from '../core/embed-cache.mjs';
import { memoryKv, indexedDbKv } from '../core/kv.mjs';

globalThis.IDBKeyRange = KR;

/** @param {number} seed @param {number} [dim] */
const vec = (seed, dim = 4) =>
  Float32Array.from({ length: dim }, (_, i) => (seed + i) / 10);

/** @type {Array<[string, () => Promise<import('../core/kv.mjs').KvStore>]>} */
const stores = [
  ['memory', async () => memoryKv()],
  ['indexeddb', async () => indexedDbKv(new IDBFactory(), 'e' + Math.random())],
];

for (const [name, make] of stores) {
  test(`[${name}] промах, затем попадание`, async () => {
    const c = new EmbedCache(await make(), 'e5', 4);
    assert.equal(await c.get('текст'), null);
    await c.put('текст', vec(1));
    const got = await c.get('текст');
    assert.ok(got);
    assert.deepEqual(Array.from(got), Array.from(vec(1)));
  });

  test(`[${name}] 🔴 смена модели ИНВАЛИДИРУЕТ кэш`, async () => {
    // Иначе векторы из разных пространств попали бы в один индекс и
    // ТИХО сломали ранжирование — отказ был бы незаметным.
    const kv = await make();
    const a = new EmbedCache(kv, 'e5-small', 4);
    await a.put('текст', vec(1));
    assert.ok(await a.get('текст'));

    const b = new EmbedCache(kv, 'e5-large', 4);
    assert.equal(await b.get('текст'), null);
  });

  test(`[${name}] смена размерности тоже инвалидирует`, async () => {
    const kv = await make();
    const a = new EmbedCache(kv, 'e5', 4);
    await a.put('текст', vec(1));
    const b = new EmbedCache(kv, 'e5', 384);
    assert.equal(await b.get('текст'), null);
  });

  test(`[${name}] данные переживают пересоздание`, async () => {
    const kv = await make();
    const a = new EmbedCache(kv, 'e5', 4);
    await a.put('устойчивый', vec(7));

    const b = new EmbedCache(kv, 'e5', 4);
    const got = await b.get('устойчивый');
    assert.ok(got);
    assert.deepEqual(Array.from(got), Array.from(vec(7)));
  });

  test(`[${name}] статистика считает попадания`, async () => {
    const c = new EmbedCache(await make(), 'e5', 4);
    await c.get('нет');
    await c.put('есть', vec(1));
    await c.get('есть');
    await c.get('есть');
    const s = c.stats();
    assert.equal(s.hits, 2);
    assert.equal(s.misses, 1);
    assert.ok(Math.abs(s.hitRate - 2 / 3) < 1e-6);
  });

  test(`[${name}] prune вытесняет наименее используемые`, async () => {
    const c = new EmbedCache(await make(), 'e5', 4);
    for (let i = 0; i < 10; i++) await c.put(`t${i}`, vec(i));
    await c.get('t5'); await c.get('t5'); await c.get('t7');

    const removed = await c.prune(3);
    assert.equal(removed, 7);
    // Часто используемый обязан уцелеть
    assert.ok(await c.get('t5'), 't5 вытеснен, хотя использовался чаще всех');
  });

  test(`[${name}] prune не трогает, пока лимит не достигнут`, async () => {
    const c = new EmbedCache(await make(), 'e5', 4);
    await c.put('a', vec(1));
    assert.equal(await c.prune(100), 0);
    assert.ok(await c.get('a'));
  });

  test(`[${name}] 🟢 withEmbedCache зовёт модель ТОЛЬКО для промахов`, async () => {
    const c = new EmbedCache(await make(), 'e5', 4);
    /** @type {string[][]} */
    const seen = [];
    const base = {
      dim: 4,
      /** @param {string[]} texts */
      async embed(texts) {
        seen.push([...texts]);
        return texts.map((_, i) => vec(i));
      },
    };
    const w = withEmbedCache(base, c);

    await w.embed(['a', 'b']);
    assert.deepEqual(seen[0], ['a', 'b']);

    // Оба известны — модель не должна вызываться вовсе
    await w.embed(['a', 'b']);
    assert.equal(seen.length, 1, 'модель вызвана на известных текстах');

    // Смешанный: модель получает ТОЛЬКО новое, пачка остаётся плотной
    await w.embed(['a', 'c', 'b', 'd']);
    assert.deepEqual(seen[1], ['c', 'd']);
  });

  test(`[${name}] 🟢 withEmbedCache сохраняет ПОРЯДОК`, async () => {
    const c = new EmbedCache(await make(), 'e5', 4);
    const base = {
      dim: 4,
      /** @param {string[]} texts */
      async embed(texts) {
        return texts.map((t) => Float32Array.from([t.charCodeAt(0), 0, 0, 0]));
      },
    };
    const w = withEmbedCache(base, c);
    await w.embed(['b']);
    const out = await w.embed(['a', 'b', 'c']);
    assert.deepEqual(out.map((v) => v[0]), [97, 98, 99]);
  });

  test(`[${name}] пустой вход не падает`, async () => {
    const c = new EmbedCache(await make(), 'e5', 4);
    const w = withEmbedCache({ dim: 4, embed: async () => [] }, c);
    assert.deepEqual(await w.embed([]), []);
  });

  test(`[${name}] clear очищает`, async () => {
    const c = new EmbedCache(await make(), 'e5', 4);
    await c.put('a', vec(1));
    await c.clear();
    assert.equal(await c.get('a'), null);
  });
}

test('🔴 векторы не путаются между текстами', async () => {
  // Коллизия ключей дала бы чужой вектор — отказ, который проявился бы
  // как необъяснимо плохое ранжирование.
  const c = new EmbedCache(memoryKv(), 'e5', 4);
  await c.put('первый', vec(1));
  await c.put('второй', vec(9));
  const a = await c.get('первый');
  const b = await c.get('второй');
  assert.ok(a && b);
  assert.notDeepEqual(Array.from(a), Array.from(b));
  assert.deepEqual(Array.from(a), Array.from(vec(1)));
});
