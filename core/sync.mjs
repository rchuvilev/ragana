// Определение, что переиндексировать. Три требования из задачи:
// «кнопка ре-индексации изменённых файлов и новых файлов» +
// «исключение удалённых файлов».
//
// Решение diff чисто функциональное и не трогает ни диск, ни БД — поэтому
// тестируется без них. Это намеренно: логика «что устарело» — то место,
// где ошибка тихо приводит к цитатам из несуществующих файлов.

/**
 * Сравнивает файлы на диске с проиндексированными.
 *
 * @param {Map<string,{mtime:number,size:number}>} disk    что лежит сейчас
 * @param {Map<string,{mtime:number,size:number}>} indexed что в индексе
 * @returns {{added:string[], changed:string[], removed:string[], same:string[]}}
 */
export function diff(disk, indexed) {
  const added = [];
  const changed = [];
  const same = [];
  const removed = [];

  for (const [path, d] of disk) {
    const prev = indexed.get(path);
    if (!prev) {
      added.push(path);
    } else if (isStale(d, prev)) {
      changed.push(path);
    } else {
      same.push(path);
    }
  }
  for (const path of indexed.keys()) {
    if (!disk.has(path)) removed.push(path);
  }
  return { added, changed, removed, same };
}

/**
 * Файл считается устаревшим при расхождении mtime ИЛИ размера.
 *
 * Размер проверяется не для красоты: на Android копирование через SAF и
 * некоторые файловые менеджеры сохраняют mtime исходника, так что отредак-
 * тированный файл приезжает со СТАРЫМ временем. По одному mtime такая
 * правка не попала бы в переиндексацию никогда.
 */
export function isStale(now, prev) {
  return now.mtime !== prev.mtime || now.size !== prev.size;
}

/** Нужна ли вообще работа. */
export function hasWork(d) {
  return d.added.length + d.changed.length + d.removed.length > 0;
}

/** Человекочитаемая сводка для кнопки/лога. */
export function describe(d) {
  if (!hasWork(d)) return `нечего делать: ${d.same.length} файлов актуальны`;
  const parts = [];
  if (d.added.length) parts.push(`новых ${d.added.length}`);
  if (d.changed.length) parts.push(`изменённых ${d.changed.length}`);
  if (d.removed.length) parts.push(`удалённых ${d.removed.length}`);
  return parts.join(', ') + ` (без изменений ${d.same.length})`;
}

/**
 * Файлы, чьи старые чанки надо выбросить из индекса.
 * Изменённые входят сюда ТОЖЕ: переиндексация без удаления старых
 * фрагментов оставила бы в выдаче обе версии документа.
 */
export function pathsToPurge(d) {
  return [...d.changed, ...d.removed];
}

/** Файлы, которые надо прочитать и разобрать заново. */
export function pathsToIngest(d) {
  return [...d.added, ...d.changed];
}
