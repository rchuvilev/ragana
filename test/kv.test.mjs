import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange as KR } from 'fake-indexeddb';
import {
  memoryKv, indexedDbKv, packVector, unpackVector, packJson, unpackJson,
} from '../core/kv.mjs';

globalThis.IDBKeyRange = KR;

/** @param {string} s */
const bytes = (s) => new TextEncoder().encode(s);
/** @param {Uint8Array | null} b */
const str = (b) => new TextDecoder().decode(b ?? new Uint8Array());

/**
 * Один и тот же набор проверок прогоняется по ОБЕИМ реализациям.
 * Иначе расхождение контракта обнаружилось бы только в браузере, где
 * отлаживать дороже всего.
 */
/** @type {Array<[string, () => Promise<import('../core/kv.mjs').KvStore>]>} */
const makers = [
  ['memory', async () => memoryKv()],
  ['indexeddb', async () => indexedDbKv(new IDBFactory(), 'db' + Math.random())],
];

for (const [name, make] of makers) {
  test(`[${name}] запись и чтение`, async () => {
    const kv = await make();
    assert.equal(await kv.get('нет'), null);
    await kv.set('a', bytes('значение'));
    assert.equal(str(await kv.get('a')), 'значение');
    await kv.close?.();
  });

  test(`[${name}] перезапись`, async () => {
    const kv = await make();
    await kv.set('a', bytes('первое'));
    await kv.set('a', bytes('второе'));
    assert.equal(str(await kv.get('a')), 'второе');
    await kv.close?.();
  });

  test(`[${name}] удаление`, async () => {
    const kv = await make();
    await kv.set('a', bytes('x'));
    await kv.delete('a');
    assert.equal(await kv.get('a'), null);
    // Удаление несуществующего не должно падать
    await kv.delete('нет-такого');
    await kv.close?.();
  });

  test(`[${name}] обход по префиксу`, async () => {
    const kv = await make();
    await kv.set('cooc:a', bytes('1'));
    await kv.set('cooc:b', bytes('2'));
    await kv.set('cache:x', bytes('3'));

    /** @type {Array<[string, string]>} */
    const found = [];
    for await (const [k, v] of kv.scan('cooc:')) found.push([k, str(v)]);
    found.sort((p, q) => p[0].localeCompare(q[0]));

    assert.deepEqual(found, [['cooc:a', '1'], ['cooc:b', '2']]);
    await kv.close?.();
  });

  test(`[${name}] 🔴 префикс НЕ захватывает чужие ключи`, async () => {
    // Без этого контроля реализация, возвращающая всё подряд, выглядела
    // бы работающей: обход нашёл бы нужное и ещё лишнее.
    const kv = await make();
    await kv.set('ab', bytes('1'));
    await kv.set('abc', bytes('2'));
    await kv.set('b', bytes('3'));

    /** @type {string[]} */
    const keys = [];
    for await (const [k] of kv.scan('ab')) keys.push(k);
    keys.sort();
    assert.deepEqual(keys, ['ab', 'abc']);
    await kv.close?.();
  });

  test(`[${name}] подсчёт`, async () => {
    const kv = await make();
    await kv.set('p:1', bytes('a'));
    await kv.set('p:2', bytes('b'));
    await kv.set('q:1', bytes('c'));
    assert.equal(await kv.count(), 3);
    assert.equal(await kv.count('p:'), 2);
    assert.equal(await kv.count('нет'), 0);
    await kv.close?.();
  });

  test(`[${name}] очистка по префиксу щадит остальное`, async () => {
    const kv = await make();
    await kv.set('p:1', bytes('a'));
    await kv.set('q:1', bytes('b'));
    await kv.clear('p:');
    assert.equal(await kv.get('p:1'), null);
    assert.equal(str(await kv.get('q:1')), 'b', 'чужой ключ уцелел');
    await kv.close?.();
  });

  test(`[${name}] полная очистка`, async () => {
    const kv = await make();
    await kv.set('a', bytes('1'));
    await kv.set('b', bytes('2'));
    await kv.clear();
    assert.equal(await kv.count(), 0);
    await kv.close?.();
  });

  test(`[${name}] 🟢 вектор переживает круг упаковки`, async () => {
    const kv = await make();
    const vec = Float32Array.from([0.1, -0.5, 0.75, 1]);
    await kv.set('v', packVector(vec));
    const stored = await kv.get('v');
    assert.ok(stored, 'вектор сохранён');
    const back = unpackVector(stored);
    assert.equal(back.length, 4);
    for (let i = 0; i < 4; i++) {
      assert.ok(Math.abs((back[i] ?? 0) - (vec[i] ?? 0)) < 1e-6, `элемент ${i}`);
    }
    await kv.close?.();
  });

  test(`[${name}] JSON переживает круг упаковки`, async () => {
    const kv = await make();
    const obj = { путь: 'файл.pdf', страница: 3, вложенное: [1, 2] };
    await kv.set('j', packJson(obj));
    const raw = await kv.get('j');
    assert.ok(raw);
    assert.deepEqual(unpackJson(raw), obj);
    await kv.close?.();
  });

  test(`[${name}] пустой обход не падает`, async () => {
    const kv = await make();
    /** @type {unknown[]} */
    const found = [];
    for await (const x of kv.scan('нет:')) found.push(x);
    assert.deepEqual(found, []);
    await kv.close?.();
  });
}

test('🔴 unpackVector КОПИРУЕТ, а не ссылается на буфер', () => {
  // Хранилище может переиспользовать буфер; вид на него молча испортил
  // бы вектор при следующей операции.
  const src = packVector(Float32Array.from([1, 2, 3, 4]));
  const vec = unpackVector(src);
  src.fill(0);
  assert.equal(vec[0], 1, 'вектор не должен зависеть от исходного буфера');
});
