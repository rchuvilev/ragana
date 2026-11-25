// Раскладка на диске и реестр файлов.
//
// Всё живёт в каталоге `ragana` РЯДОМ С ИСПОЛНЯЕМЫМ ФАЙЛОМ, а не в
// домашней папке: инструмент переносится вместе со своими данными на
// флешке, и копия бинаря = копия рабочего места. Создаётся при первом
// запуске.
//
//   ragana/
//     ragana-db.sqlite     база RAG (векторы, чанки)
//     knowledgebase/       сюда пользователь кладёт документы
//     knowledgebase.json   реестр: относительный путь -> хэш
//     searches/            история поисков

import { dirname, join, relative, sep } from 'node:path';
import { mkdir, readdir, stat, readFile, writeFile } from 'node:fs/promises';

export interface Layout {
  /** Корень `ragana/`. */
  root: string;
  dbFile: string;
  docsDir: string;
  registryFile: string;
  searchesDir: string;
}

/**
 * Каталог, рядом с которым разворачивается раскладка.
 *
 * В скомпилированном бинаре process.execPath указывает на сам бинарь —
 * это и нужно. В режиме разработки (bun run src/...) execPath указывает
 * на интерпретатор bun, что дало бы раскладку в /usr/local/bin, поэтому
 * там берётся рабочий каталог.
 */
export function baseDir(): string {
  const override = process.env.RAGANA_HOME;
  if (override) return override;

  const exec = process.execPath;
  const isBunItself = /[\\/]bun(\.exe)?$/.test(exec);
  return isBunItself ? process.cwd() : dirname(exec);
}

export function layoutOf(base = baseDir()): Layout {
  const root = join(base, 'ragana');
  return {
    root,
    dbFile: join(root, 'ragana-db.sqlite'),
    docsDir: join(root, 'knowledgebase'),
    registryFile: join(root, 'knowledgebase.json'),
    searchesDir: join(root, 'searches'),
  };
}

export interface EnsureResult {
  layout: Layout;
  /** true, если каталога не было и он создан сейчас. */
  created: boolean;
}

/** Создаёт раскладку, если её нет. Идемпотентно. */
export async function ensureWorkspace(base = baseDir()): Promise<EnsureResult> {
  const layout = layoutOf(base);
  const existed = await Bun.file(layout.registryFile).exists();

  await mkdir(layout.docsDir, { recursive: true });
  await mkdir(layout.searchesDir, { recursive: true });

  if (!existed) {
    await writeFile(layout.registryFile, JSON.stringify({}, null, 2), 'utf8');
    // Подсказка внутри самой папки: пользователь откроет её через --open
    // и должен сразу понять, что делать.
    await writeFile(
      join(layout.docsDir, 'ПРОЧТИ-МЕНЯ.md'),
      [
        '# Папка документов',
        '',
        'Кладите сюда файлы — вложенные папки поддерживаются.',
        '',
        '| тип | что делает ragana |',
        '|---|---|',
        '| текст, Markdown, CSV, HTML | читает как есть |',
        '| PDF | берёт текстовый слой, для сканов включает OCR |',
        '| изображения, сканы | распознаёт текст (66 языков) |',
        '| аудио, видео | расшифровывает речь по флагу `--media` |',
        '',
        'Рядом с каждым не-текстовым файлом появится `.md` — это',
        'расшифровка с номерами страниц или таймкодами. Её можно читать',
        'и править; при изменении оригинала она пересоздаётся.',
        '',
        'После добавления файлов запустите `ragana --index`.',
      ].join('\n'),
      'utf8',
    );
  }

  return { layout, created: !existed };
}

// ---------- реестр ----------

/** Относительный путь -> хэш содержимого. */
export type Registry = Record<string, string>;

export async function loadRegistry(file: string): Promise<Registry> {
  try {
    const text = await readFile(file, 'utf8');
    const data = JSON.parse(text);
    // Защита от повреждённого файла: пустой реестр означает полную
    // переиндексацию, что безопаснее, чем падение.
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export async function saveRegistry(file: string, reg: Registry): Promise<void> {
  const sorted: Registry = {};
  for (const k of Object.keys(reg).sort()) sorted[k] = reg[k]!;
  await writeFile(file, JSON.stringify(sorted, null, 2), 'utf8');
}

/** Хэш содержимого файла. */
export async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest('hex');
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__',
  '.cache', '.thumbnails', '.trash', 'build', 'dist',
]);

export interface ScannedFile {
  /** Путь относительно knowledgebase, всегда через '/'. */
  rel: string;
  abs: string;
  size: number;
  mtime: number;
}

/**
 * Обход папки документов.
 *
 * Расшифровки (.md рядом с оригиналом) ИСКЛЮЧАЮТСЯ из обхода как
 * самостоятельные файлы: они производные, и включение их в реестр
 * означало бы, что правка оригинала порождает два «изменённых файла».
 */
export async function scanDocs(docsDir: string): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  const transcripts = new Set<string>();

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(abs);
        continue;
      }
      if (!e.isFile()) continue;

      const rel = relative(docsDir, abs).split(sep).join('/');
      // *.<ext>.md — расшифровка, а не документ
      if (/\.[^./]+\.md$/i.test(rel)) {
        transcripts.add(rel);
        continue;
      }
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      if (st.size === 0) continue;
      out.push({ rel, abs, size: st.size, mtime: Math.floor(st.mtimeMs) });
    }
  }

  await walk(docsDir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export interface RegistryDiff {
  added: string[];
  changed: string[];
  removed: string[];
  same: string[];
}

/**
 * Что переиндексировать.
 *
 * Правило из требований: файл переиндексируется, если ключа нет в
 * реестре (новый) ЛИБО хэш изменился (правлен). Ключи, исчезнувшие с
 * диска, означают удалённые файлы — их чанки надо убрать из базы.
 */
export function diffRegistry(
  current: Map<string, string>, registry: Registry,
): RegistryDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const same: string[] = [];
  const removed: string[] = [];

  for (const [rel, hash] of current) {
    const known = registry[rel];
    if (known === undefined) added.push(rel);
    else if (known !== hash) changed.push(rel);
    else same.push(rel);
  }
  for (const rel of Object.keys(registry)) {
    if (!current.has(rel)) removed.push(rel);
  }
  return { added, changed, removed, same };
}

export function hasWork(d: RegistryDiff): boolean {
  return d.added.length + d.changed.length + d.removed.length > 0;
}

export function describeDiff(d: RegistryDiff): string {
  if (!hasWork(d)) return `всё актуально: ${d.same.length} файлов`;
  const parts: string[] = [];
  if (d.added.length) parts.push(`новых ${d.added.length}`);
  if (d.changed.length) parts.push(`изменённых ${d.changed.length}`);
  if (d.removed.length) parts.push(`удалённых ${d.removed.length}`);
  return `${parts.join(', ')} (без изменений ${d.same.length})`;
}

// ---------- история поисков ----------

/**
 * Имя файла истории: <yyyy-mm-dd---hh-mm-ss---ms>.json
 * Формат из требований; сортируется лексикографически = хронологически.
 */
export function searchFileName(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return [
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`,
    `${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`,
    p(now.getMilliseconds(), 3),
  ].join('---') + '.json';
}

/**
 * Запись истории поиска.
 * Структура из требований: { "<промпт>": { "<путь>": "<результат>" } }
 */
export async function writeSearchLog(
  searchesDir: string,
  prompt: string,
  results: Array<{ path: string; text: string }>,
  now = new Date(),
): Promise<string> {
  const byPath: Record<string, string> = {};
  for (const r of results) {
    // Один файл может дать несколько фрагментов — склеиваем, сохраняя
    // порядок ранжирования, иначе часть результатов потерялась бы.
    byPath[r.path] = byPath[r.path] ? `${byPath[r.path]}\n\n---\n\n${r.text}` : r.text;
  }
  const file = join(searchesDir, searchFileName(now));
  await writeFile(file, JSON.stringify({ [prompt]: byPath }, null, 2), 'utf8');
  return file;
}
