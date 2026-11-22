import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VectorStore, normalize, DIM } from '../core/vector.mjs';

const rnd = (seed) => {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
};
const vec = (seed, dim = DIM) => {
  const r = rnd(seed);
  return Float32Array.from({ length: dim }, r);
};

test('normalize даёт единичную длину', () => {
  const v = normalize(Float32Array.from([3, 4]));
  assert.ok(Math.abs(Math.hypot(v[0], v[1]) - 1) < 1e-6);
});

test('normalize не делит на ноль', () => {
  const v = normalize(new Float32Array(4));
  assert.ok(v.every((x) => x === 0), 'нулевой вектор остаётся нулевым');
});

test('поиск находит сам вектор первым со score ~1', () => {
  const vs = new VectorStore(8);
  for (let i = 0; i < 20; i++) vs.add(`d${i}`, vec(i + 1, 8));
  const target = vec(7, 8);
  const hits = vs.search(target, 3);
  assert.equal(hits[0].id, 'd6');
  assert.ok(hits[0].score > 0.999, `score=${hits[0].score}`);
});

test('результаты отсортированы по убыванию', () => {
  const vs = new VectorStore(8);
  for (let i = 0; i < 30; i++) vs.add(`d${i}`, vec(i + 1, 8));
  const hits = vs.search(vec(3, 8), 5);
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].score >= hits[i].score, 'порядок нарушен');
  }
});

test('k больше размера индекса не падает', () => {
  const vs = new VectorStore(4);
  vs.add('a', vec(1, 4));
  assert.equal(vs.search(vec(1, 4), 10).length, 1);
});

test('поиск в пустом индексе возвращает []', () => {
  assert.deepEqual(new VectorStore(4).search(vec(1, 4), 5), []);
});

test('рост ёмкости сохраняет ранее добавленное', () => {
  const vs = new VectorStore(4, 1);
  for (let i = 0; i < 50; i++) vs.add(`d${i}`, vec(i + 1, 4));
  assert.equal(vs.size, 50);
  // первый добавленный всё ещё находится
  assert.equal(vs.search(vec(1, 4), 1)[0].id, 'd0');
});

test('removeWhere удаляет и сохраняет остальные НАХОДИМЫМИ', () => {
  const vs = new VectorStore(8);
  for (let i = 0; i < 10; i++) vs.add(`f${i % 2}:${i}`, vec(i + 1, 8));
  const removed = vs.removeWhere((id) => id.startsWith('f0:'));
  assert.equal(removed, 5);
  assert.equal(vs.size, 5);
  // позитивный контроль: уцелевший вектор ДЕЙСТВИТЕЛЬНО ищется,
  // а не просто числится в ids — сдвиг copyWithin мог побить данные
  const hit = vs.search(vec(2, 8), 1)[0];
  assert.equal(hit.id, 'f1:1');
  assert.ok(hit.score > 0.999, `после сжатия score=${hit.score}`);
  assert.ok(!vs.ids.some((id) => id.startsWith('f0:')));
});

test('removeWhere без совпадений ничего не трогает', () => {
  const vs = new VectorStore(4);
  vs.add('a', vec(1, 4));
  assert.equal(vs.removeWhere(() => false), 0);
  assert.equal(vs.size, 1);
});

test('removeWhere удаляющий всё оставляет рабочий индекс', () => {
  const vs = new VectorStore(4);
  for (let i = 0; i < 5; i++) vs.add(`x${i}`, vec(i + 1, 4));
  assert.equal(vs.removeWhere(() => true), 5);
  assert.equal(vs.size, 0);
  assert.deepEqual(vs.search(vec(1, 4), 3), []);
  vs.add('new', vec(9, 4)); // индекс пригоден к дальнейшей работе
  assert.equal(vs.size, 1);
});

test('serialize/deserialize — полный круг', () => {
  const vs = new VectorStore(8);
  for (let i = 0; i < 12; i++) vs.add(`d${i}`, vec(i + 1, 8));
  const back = VectorStore.deserialize(vs.serialize());
  assert.equal(back.size, vs.size);
  assert.deepEqual(back.ids, vs.ids);
  const a = vs.search(vec(5, 8), 3);
  const b = back.search(vec(5, 8), 3);
  assert.deepEqual(b.map((h) => h.id), a.map((h) => h.id));
  assert.ok(Math.abs(a[0].score - b[0].score) < 1e-6);
});

test('serialize не тащит неиспользованный хвост буфера', () => {
  const vs = new VectorStore(4, 512);
  vs.add('a', vec(1, 4));
  assert.equal(vs.serialize().data.length, 4, 'выгружается только size*dim');
});

test('неверная размерность — явная ошибка', () => {
  const vs = new VectorStore(8);
  assert.throws(() => vs.add('a', new Float32Array(7)), /размерность/);
});
