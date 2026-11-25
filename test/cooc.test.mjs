import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange as KR } from 'fake-indexeddb';
import { Cooc } from '../core/cooc.mjs';
import { memoryKv, indexedDbKv } from '../core/kv.mjs';

globalThis.IDBKeyRange = KR;

/** @param {Cooc} c */
async function fill(c) {
  // «ипотека» устойчиво соседствует со «ставка» и «погашение»
  for (let i = 0; i < 5; i++) {
    c.add('Ипотека оформляется по ставке банка с досрочным погашением');
  }
  for (let i = 0; i < 4; i++) {
    c.add('Ставка по ипотеке фиксируется договором погашения');
  }
  // «гарантия» живёт в своём контексте
  for (let i = 0; i < 4; i++) {
    c.add('Гарантия распространяется на ремонт оборудования поставщиком');
  }
  await c.flush();
}

/**
 * Прогон по ОБЕИМ реализациям хранилища: иначе расхождение контракта
 * всплыло бы только в браузере, где отлаживать дороже всего.
 * @type {Array<[string, () => Promise<import('../core/kv.mjs').KvStore>]>}
 */
const stores = [
  ['memory', async () => memoryKv()],
  ['indexeddb', async () => indexedDbKv(new IDBFactory(), 'c' + Math.random())],
];

for (const [name, make] of stores) {
  test(`[${name}] словарь наполняется`, async () => {
    const c = new Cooc(await make());
    await fill(c);
    const s = await c.stats();
    assert.ok(s.terms > 5, `терминов ${s.terms}`);
    assert.ok(s.pairs > 10, `пар ${s.pairs}`);
  });

  test(`[${name}] 🟢 находит связанные термины`, async () => {
    const c = new Cooc(await make());
    await fill(c);
    const rel = (await c.related('ипотека', 10)).map((r) => r.term);
    assert.ok(rel.some((t) => t.startsWith('ставк')), `ставка: ${rel}`);
    assert.ok(rel.some((t) => t.startsWith('погаш')), `погашение: ${rel}`);
  });

  test(`[${name}] 🔴 НЕ связывает термины из разных контекстов`, async () => {
    // Без контроля словарь, возвращающий всё подряд, выглядел бы рабочим
    const c = new Cooc(await make());
    await fill(c);
    const rel = (await c.related('ипотека', 20)).map((r) => r.term);
    assert.ok(!rel.some((t) => t.startsWith('гарант')), 'гарантия не связана');
    assert.ok(!rel.some((t) => t.startsWith('оборудован')), 'оборудование не связано');
  });

  test(`[${name}] редкий термин не даёт связей`, async () => {
    const c = new Cooc(await make());
    c.add('Уникальное словосочетание встречается однажды');
    await c.flush();
    assert.deepEqual(await c.related('уникальное'), []);
  });

  test(`[${name}] неизвестный термин — пусто`, async () => {
    const c = new Cooc(await make());
    await fill(c);
    assert.deepEqual(await c.related('квазимодо'), []);
    assert.deepEqual(await c.expand('квазимодо кракозябра'), []);
  });

  test(`[${name}] expand не дублирует присутствующее`, async () => {
    const c = new Cooc(await make());
    await fill(c);
    const added = await c.expand('ипотека ставка');
    assert.ok(!added.some((t) => t.startsWith('ставк')), 'ставка не продублирована');
  });

  test(`[${name}] expand соблюдает предел`, async () => {
    const c = new Cooc(await make());
    await fill(c);
    const added = await c.expand('ипотека ставка погашение', 2, 3);
    assert.ok(added.length <= 3, `получено ${added.length}`);
  });

  test(`[${name}] стоп-слова игнорируются`, async () => {
    const c = new Cooc(await make());
    for (let i = 0; i < 5; i++) c.add('и в на с по не а о от за для при');
    await c.flush();
    assert.equal((await c.stats()).pairs, 0);
  });

  test(`[${name}] clear очищает`, async () => {
    const c = new Cooc(await make());
    await fill(c);
    assert.ok((await c.stats()).terms > 0);
    await c.clear();
    assert.deepEqual(await c.stats(), { terms: 0, pairs: 0 });
  });

  test(`[${name}] накопление суммируется между сбросами`, async () => {
    const c = new Cooc(await make());
    c.add('Ипотека со ставкой банка');
    await c.flush();
    const first = (await c.stats()).pairs;
    c.add('Ипотека со ставкой банка');
    await c.flush();
    // Пары те же, значения должны вырасти, а количество ключей — нет
    assert.equal((await c.stats()).pairs, first, 'ключи не размножились');
  });

  test(`[${name}] пустой текст не ломает`, async () => {
    const c = new Cooc(await make());
    c.add('');
    c.add('одно');
    await c.flush();
    assert.equal((await c.stats()).pairs, 0);
  });
}

test('🟢 данные переживают пересоздание объекта на том же хранилище', async () => {
  const kv = memoryKv();
  const a = new Cooc(kv);
  await fill(a);
  const before = await a.stats();

  const b = new Cooc(kv);
  assert.deepEqual(await b.stats(), before);
  assert.ok((await b.related('ипотека')).length > 0, 'связи читаются');
});
