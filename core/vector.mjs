// Векторный поиск: плоский перебор по Float32Array.
//
// Почему не HNSW: эмбеддинг ОДНОГО запроса стоит ~438 мс на Snapdragon 732G
// (замер 2026-11-22, multilingual-e5-small, ONNX/WASM). Перебор 5000 векторов
// по 384 измерения — это 1.9М FMA, единицы миллисекунд. Индекс ускоряет те
// 2% времени, которые и так не видны, а стоит зависимости с WASM, которая
// ломается в MV3-расширении. Меряется в bench(), а не предполагается.

/** Размерность по умолчанию: multilingual-e5-small. */
export const DIM = 384;

/**
 * Косинусное сходство для ПРЕДНОРМИРОВАННЫХ векторов = скалярное произведение.
 * Нормализация делается один раз при вставке, а не на каждом сравнении.
 */
export function dot(a, b, offB = 0, dim = a.length) {
  let s = 0;
  for (let i = 0; i < dim; i++) s += a[i] * b[offB + i];
  return s;
}

/** Нормализует вектор на месте. Возвращает его же. */
export function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/**
 * Хранилище векторов в одном непрерывном Float32Array.
 *
 * Одна большая типизированная матрица, а не массив массивов: это
 * последовательный доступ к памяти и отсутствие 5000 мелких объектов,
 * которые иначе давили бы на сборщик мусора.
 */
export class VectorStore {
  constructor(dim = DIM, capacity = 1024) {
    this.dim = dim;
    this.size = 0;
    this.data = new Float32Array(dim * capacity);
    this.ids = [];
  }

  get capacity() {
    return this.data.length / this.dim;
  }

  /** Удваивает ёмкость, сохраняя уже записанное. */
  _grow(minCapacity) {
    let cap = Math.max(1, this.capacity);
    while (cap < minCapacity) cap *= 2;
    const next = new Float32Array(this.dim * cap);
    next.set(this.data.subarray(0, this.size * this.dim));
    this.data = next;
  }

  /** Добавляет вектор (копируется и нормализуется). Возвращает индекс. */
  add(id, vec) {
    if (vec.length !== this.dim) {
      throw new Error(`размерность ${vec.length} != ${this.dim}`);
    }
    if (this.size + 1 > this.capacity) this._grow(this.size + 1);
    const off = this.size * this.dim;
    this.data.set(vec, off);
    normalize(this.data.subarray(off, off + this.dim));
    this.ids.push(id);
    return this.size++;
  }

  /**
   * Удаляет все векторы, чей id удовлетворяет предикату.
   *
   * Сжатие на месте: живые строки сдвигаются к началу. Нужно для
   * «исключения удалённых файлов» — без этого индекс только растёт
   * и начинает цитировать документы, которых уже нет на диске.
   */
  removeWhere(pred) {
    let write = 0;
    const keptIds = [];
    for (let read = 0; read < this.size; read++) {
      if (pred(this.ids[read])) continue;
      if (write !== read) {
        this.data.copyWithin(
          write * this.dim,
          read * this.dim,
          (read + 1) * this.dim,
        );
      }
      keptIds.push(this.ids[read]);
      write++;
    }
    const removed = this.size - write;
    this.size = write;
    this.ids = keptIds;
    return removed;
  }

  /**
   * Top-k по косинусному сходству. Запрос нормализуется (не на месте).
   *
   * Вставка в маленький отсортированный массив вместо сортировки всего:
   * при k=5 и n=5000 это 5000 сравнений вместо n·log n.
   */
  search(query, k = 5) {
    if (this.size === 0) return [];
    const q = normalize(Float32Array.from(query));
    const top = [];
    for (let i = 0; i < this.size; i++) {
      const score = dot(q, this.data, i * this.dim, this.dim);
      if (top.length < k) {
        top.push({ index: i, id: this.ids[i], score });
        top.sort((a, b) => b.score - a.score);
      } else if (score > top[top.length - 1].score) {
        top[top.length - 1] = { index: i, id: this.ids[i], score };
        top.sort((a, b) => b.score - a.score);
      }
    }
    return top;
  }

  /** Плоская выгрузка для IndexedDB: один ArrayBuffer + список id. */
  serialize() {
    return {
      dim: this.dim,
      size: this.size,
      ids: this.ids.slice(),
      data: this.data.slice(0, this.size * this.dim),
    };
  }

  static deserialize(obj) {
    const vs = new VectorStore(obj.dim, Math.max(1, obj.size));
    vs.data.set(obj.data);
    vs.size = obj.size;
    vs.ids = obj.ids.slice();
    return vs;
  }
}
