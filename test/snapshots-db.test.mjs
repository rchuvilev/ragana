import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange as KR } from 'fake-indexeddb';
import {
  SnapshotLog, SNAPSHOTS, makeSnapshot, snapshotToMap,
} from '../core/snapshots-db.mjs';
import { diffSnapshots, entry } from '../core/snapshot.mjs';

globalThis.IDBKeyRange = KR;

// Каждый тест — своя чистая БД, иначе они видят состояние друг друга.
async function freshDb(name = 'db' + Math.random()) {
  const factory = new IDBFactory();
  return new Promise((res, rej) => {
    const req = factory.open(name, 1);
    req.onupgradeneeded = (e) => SnapshotLog.upgrade(e.target.result);
    req.onsuccess = () => res(new SnapshotLog(req.result));
    req.onerror = () => rej(req.error);
  });
}

const files = (...rows) =>
  new Map(rows.map(([p, h, s = 10]) => [p, entry(p, h, s)]));

test('makeSnapshot считает файлы и байты', () => {
  const s = makeSnapshot('/docs', files(['a', 'H1', 100], ['b', 'H2', 50]));
  assert.equal(s.count, 2);
  assert.equal(s.bytes, 150);
  assert.equal(s.root, '/docs');
  assert.ok(s.ts > 0);
});

test('snapshotToMap — обратное преобразование без потерь', () => {
  const orig = files(['a', 'H1'], ['b', 'H2']);
  const back = snapshotToMap(makeSnapshot('/d', orig));
  assert.deepEqual([...back.keys()].sort(), ['a', 'b']);
  assert.equal(back.get('a').hash, 'H1');
});

test('snapshotToMap(null) -> пустая Map', () => {
  assert.equal(snapshotToMap(null).size, 0);
});

test('put/latest — возвращается самый свежий', async () => {
  const log = await freshDb();
  await log.put(makeSnapshot('/docs', files(['a', 'H1']), { ts: 1000 }));
  await log.put(makeSnapshot('/docs', files(['a', 'H2']), { ts: 2000 }));
  const got = await log.latest('/docs');
  assert.equal(got.ts, 2000);
  assert.equal(got.files.a.hash, 'H2');
});

test('latest для неизвестного корня -> null', async () => {
  const log = await freshDb();
  assert.equal(await log.latest('/нет-такого'), null);
});

test('корни изолированы друг от друга', async () => {
  const log = await freshDb();
  await log.put(makeSnapshot('/a', files(['x', 'H1']), { ts: 1 }));
  await log.put(makeSnapshot('/b', files(['y', 'H2']), { ts: 2 }));
  assert.equal((await log.latest('/a')).files.x.hash, 'H1');
  assert.ok(!(await log.latest('/a')).files.y, 'чужой файл не протёк');
});

test('🟢 сквозной сценарий: снимок -> diff со следующим', async () => {
  const log = await freshDb();
  await log.put(makeSnapshot('/docs', files(['keep', 'A'], ['edit', 'B1'], ['gone', 'C']), { ts: 1 }));

  const prev = snapshotToMap(await log.latest('/docs'));
  const now = files(['keep', 'A'], ['edit', 'B2'], ['fresh', 'D']);
  const d = diffSnapshots(now, prev);

  assert.deepEqual(d.same, ['keep']);
  assert.deepEqual(d.changed, ['edit']);
  assert.deepEqual(d.added, ['fresh']);
  assert.deepEqual(d.removed, ['gone']);

  await log.put(makeSnapshot('/docs', now, { ts: 2 }));
  // повторный diff против нового снимка обязан дать пусто
  const d2 = diffSnapshots(now, snapshotToMap(await log.latest('/docs')));
  assert.equal(d2.added.length + d2.changed.length + d2.removed.length, 0,
    'после записи снимка работа не должна повторяться');
});

test('history: по убыванию ts и без тяжёлого files', async () => {
  const log = await freshDb();
  for (let i = 1; i <= 5; i++) {
    await log.put(makeSnapshot('/docs', files(['a', 'H' + i]), { ts: i * 100 }));
  }
  const h = await log.history('/docs', 3);
  assert.deepEqual(h.map((x) => x.ts), [500, 400, 300]);
  assert.equal(h[0].files, undefined, 'список не тащит содержимое снимка');
  assert.equal(h[0].count, 1);
});

test('prune оставляет N последних', async () => {
  const log = await freshDb();
  for (let i = 1; i <= 8; i++) {
    await log.put(makeSnapshot('/docs', files(['a', 'H' + i]), { ts: i }));
  }
  const removed = await log.prune('/docs', 3);
  assert.equal(removed, 5);
  const h = await log.history('/docs', 99);
  assert.deepEqual(h.map((x) => x.ts), [8, 7, 6]);
  assert.equal((await log.latest('/docs')).ts, 8, 'свежий уцелел');
});

test('prune не трогает другие корни', async () => {
  const log = await freshDb();
  for (let i = 1; i <= 5; i++) await log.put(makeSnapshot('/a', files(['x', 'H']), { ts: i }));
  await log.put(makeSnapshot('/b', files(['y', 'H']), { ts: 1 }));
  await log.prune('/a', 1);
  assert.equal((await log.history('/b', 9)).length, 1, 'чужая история цела');
});

test('clear(root) чистит только свой корень', async () => {
  const log = await freshDb();
  await log.put(makeSnapshot('/a', files(['x', 'H']), { ts: 1 }));
  await log.put(makeSnapshot('/b', files(['y', 'H']), { ts: 2 }));
  await log.clear('/a');
  assert.equal(await log.latest('/a'), null);
  assert.ok(await log.latest('/b'), '/b не затронут');
});
