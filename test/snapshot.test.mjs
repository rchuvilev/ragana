import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  hashBytes, entry, fastSkip, diffSnapshots,
  hasWork, pathsToPurge, pathsToIngest, describe,
} from '../core/snapshot.mjs';

const snap = (...rows) => new Map(rows.map(([p, h, s = 10]) => [p, entry(p, h, s)]));

test('hashBytes: одинаковый вход -> одинаковый хэш, разный -> разный', async () => {
  const a = await hashBytes(webcrypto.subtle, new TextEncoder().encode('привет'));
  const b = await hashBytes(webcrypto.subtle, new TextEncoder().encode('привет'));
  const c = await hashBytes(webcrypto.subtle, new TextEncoder().encode('привет!'));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/, 'ровно 64 hex-символа');
});

test('hashBytes: пустой файл не ломается', async () => {
  const h = await hashBytes(webcrypto.subtle, new Uint8Array(0));
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('новый файл', () => {
  const d = diffSnapshots(snap(['a', 'H1']), new Map());
  assert.deepEqual(d.added, ['a']);
  assert.equal(hasWork(d), true);
});

test('изменённый файл определяется по ХЭШУ', () => {
  const d = diffSnapshots(snap(['a', 'H2']), snap(['a', 'H1']));
  assert.deepEqual(d.changed, ['a']);
  assert.deepEqual(d.added, []);
});

test('совпадающий хэш => работы нет, даже если mtime уехал', () => {
  const now = new Map([['a', { path: 'a', hash: 'H1', size: 10, mtime: 999 }]]);
  const prev = new Map([['a', { path: 'a', hash: 'H1', size: 10, mtime: 1 }]]);
  const d = diffSnapshots(now, prev);
  assert.deepEqual(d.same, ['a']);
  assert.equal(hasWork(d), false, 'mtime НЕ участвует в решении');
});

test('удалённый файл', () => {
  const d = diffSnapshots(new Map(), snap(['a', 'H1']));
  assert.deepEqual(d.removed, ['a']);
  assert.deepEqual(pathsToPurge(d), ['a']);
});

test('переименование распознаётся и НЕ требует переэмбеддинга', () => {
  const d = diffSnapshots(snap(['new/a.txt', 'H1']), snap(['old/a.txt', 'H1']));
  assert.deepEqual(d.renamed, [{ from: 'old/a.txt', to: 'new/a.txt', hash: 'H1' }]);
  assert.deepEqual(d.added, [], 'не считается новым');
  assert.deepEqual(d.removed, [], 'не считается удалённым');
  assert.deepEqual(pathsToIngest(d), [], 'эмбеддинг не нужен');
});

test('два файла с ОДИНАКОВЫМ содержимым не схлопываются', () => {
  // дубликаты — обычное дело в папке документов; наивный hash->path
  // сопоставил бы оба переименования в одно и потерял файл
  const d = diffSnapshots(snap(['x1', 'H'], ['x2', 'H']), snap(['y1', 'H'], ['y2', 'H']));
  assert.equal(d.renamed.length, 2);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
});

test('переименование + одновременно новый файл с тем же хэшем', () => {
  // один исчез, два появились с тем же хэшем: одно переименование, один новый
  const d = diffSnapshots(snap(['a', 'H'], ['b', 'H']), snap(['c', 'H']));
  assert.equal(d.renamed.length, 1);
  assert.equal(d.added.length, 1);
  assert.deepEqual(d.removed, []);
});

test('изменённый файл попадает И в purge, И в ingest', () => {
  const d = diffSnapshots(snap(['a', 'H2']), snap(['a', 'H1']));
  assert.ok(pathsToPurge(d).includes('a'), 'старые чанки надо убрать');
  assert.ok(pathsToIngest(d).includes('a'), 'и заново разобрать');
});

test('пустые снимки с обеих сторон', () => {
  const d = diffSnapshots(new Map(), new Map());
  assert.equal(hasWork(d), false);
  assert.match(describe(d), /актуально: 0/);
});

test('смешанный сценарий', () => {
  const d = diffSnapshots(
    snap(['keep', 'A'], ['edit', 'B2'], ['fresh', 'C'], ['moved/f', 'D']),
    snap(['keep', 'A'], ['edit', 'B1'], ['gone', 'E'], ['orig/f', 'D']),
  );
  assert.deepEqual(d.same, ['keep']);
  assert.deepEqual(d.changed, ['edit']);
  assert.deepEqual(d.added, ['fresh']);
  assert.deepEqual(d.removed, ['gone']);
  assert.equal(d.renamed.length, 1);
  assert.match(describe(d), /новых 1.*изменённых 1.*перемещённых 1.*удалённых 1/s);
});

test('fastSkip разрешает пропуск только при совпадении mtime И size', () => {
  const prev = { hash: 'H', size: 10, mtime: 100 };
  assert.equal(fastSkip({ size: 10, mtime: 100 }, prev), true);
  assert.equal(fastSkip({ size: 11, mtime: 100 }, prev), false, 'размер другой');
  assert.equal(fastSkip({ size: 10, mtime: 101 }, prev), false, 'время другое');
  assert.equal(fastSkip({ size: 10, mtime: 0 }, prev), false, 'mtime недоступен');
  assert.equal(fastSkip({ size: 10, mtime: 100 }, null), false, 'нет прошлого');
  assert.equal(fastSkip({ size: 10, mtime: 100 }, { size: 10, mtime: 100 }), false,
    'нет прошлого хэша — переиспользовать нечего');
});
