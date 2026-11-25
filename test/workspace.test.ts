import { test, expect } from 'bun:test';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  layoutOf, ensureWorkspace, loadRegistry, saveRegistry,
  diffRegistry, describeDiff, hasWork, searchFileName,
  writeSearchLog, scanDocs, hashFile,
} from '../src/workspace.ts';
import { parseArgs } from '../src/main.ts';

const tmp = () => `/tmp/ragana-ws-${Math.random().toString(36).slice(2)}`;

test('раскладка строится рядом с указанным каталогом', () => {
  const l = layoutOf('/opt/app');
  expect(l.root).toBe('/opt/app/ragana');
  expect(l.dbFile).toBe('/opt/app/ragana/ragana-db.sqlite');
  expect(l.docsDir).toBe('/opt/app/ragana/knowledgebase');
  expect(l.registryFile).toBe('/opt/app/ragana/knowledgebase.json');
  expect(l.searchesDir).toBe('/opt/app/ragana/searches');
});

test('🟢 первый запуск создаёт всё необходимое', async () => {
  const base = tmp();
  const { layout, created } = await ensureWorkspace(base);
  expect(created).toBe(true);
  expect(await Bun.file(layout.registryFile).exists()).toBe(true);
  // подсказка внутри папки — пользователь откроет её через --open
  expect(await Bun.file(join(layout.docsDir, 'ПРОЧТИ-МЕНЯ.md')).exists()).toBe(true);
  expect(await loadRegistry(layout.registryFile)).toEqual({});
  await rm(base, { recursive: true, force: true });
});

test('повторный запуск ничего не перезаписывает', async () => {
  const base = tmp();
  const { layout } = await ensureWorkspace(base);
  await saveRegistry(layout.registryFile, { 'a.txt': 'HASH' });

  const again = await ensureWorkspace(base);
  expect(again.created).toBe(false);
  // реестр обязан уцелеть, иначе каждый запуск = полная переиндексация
  expect(await loadRegistry(layout.registryFile)).toEqual({ 'a.txt': 'HASH' });
  await rm(base, { recursive: true, force: true });
});

test('повреждённый реестр читается как пустой, а не падает', async () => {
  const base = tmp();
  const { layout } = await ensureWorkspace(base);
  await writeFile(layout.registryFile, '{это не json', 'utf8');
  // Пустой реестр = полная переиндексация: медленно, но корректно.
  expect(await loadRegistry(layout.registryFile)).toEqual({});
  await rm(base, { recursive: true, force: true });
});

test('реестр сохраняется отсортированным', async () => {
  const base = tmp();
  const { layout } = await ensureWorkspace(base);
  await saveRegistry(layout.registryFile, { 'b': '2', 'a': '1', 'c': '3' });
  const raw = await Bun.file(layout.registryFile).text();
  // Отсортированный ключами файл даёт осмысленный diff в git
  expect(Object.keys(JSON.parse(raw))).toEqual(['a', 'b', 'c']);
  await rm(base, { recursive: true, force: true });
});

test('🔴 diff реестра: новый, изменённый, удалённый, неизменный', () => {
  const current = new Map([
    ['keep.txt', 'H1'],
    ['edit.txt', 'H2new'],
    ['fresh.txt', 'H3'],
  ]);
  const registry = {
    'keep.txt': 'H1',
    'edit.txt': 'H2old',
    'gone.txt': 'H4',
  };
  const d = diffRegistry(current, registry);
  expect(d.same).toEqual(['keep.txt']);
  expect(d.changed).toEqual(['edit.txt']);
  expect(d.added).toEqual(['fresh.txt']);
  expect(d.removed).toEqual(['gone.txt']);
  expect(hasWork(d)).toBe(true);
  expect(describeDiff(d)).toMatch(/новых 1.*изменённых 1.*удалённых 1/);
});

test('diff без изменений — работы нет', () => {
  const d = diffRegistry(new Map([['a', 'H']]), { a: 'H' });
  expect(hasWork(d)).toBe(false);
  expect(describeDiff(d)).toMatch(/всё актуально: 1/);
});

test('🔴 расшифровки НЕ попадают в реестр как документы', async () => {
  // Иначе правка оригинала порождала бы два «изменённых файла», и
  // расшифровка индексировалась бы дважды — сама по себе и как
  // производная.
  const base = tmp();
  const { layout } = await ensureWorkspace(base);
  await writeFile(join(layout.docsDir, 'doc.pdf'), 'fake pdf', 'utf8');
  await writeFile(join(layout.docsDir, 'doc.pdf.md'), '## [с. 1]\n\nтекст', 'utf8');
  await writeFile(join(layout.docsDir, 'заметка.md'), 'обычный markdown', 'utf8');

  const files = await scanDocs(layout.docsDir);
  const names = files.map((f) => f.rel).sort();
  expect(names).toContain('doc.pdf');
  expect(names).toContain('заметка.md');
  expect(names).not.toContain('doc.pdf.md');
  await rm(base, { recursive: true, force: true });
});

test('обход заходит во вложенные папки', async () => {
  const base = tmp();
  const { layout } = await ensureWorkspace(base);
  await mkdir(join(layout.docsDir, 'а/б'), { recursive: true });
  await writeFile(join(layout.docsDir, 'а/б/глубоко.txt'), 'текст', 'utf8');
  const files = await scanDocs(layout.docsDir);
  expect(files.map((f) => f.rel)).toContain('а/б/глубоко.txt');
  await rm(base, { recursive: true, force: true });
});

test('хэш меняется вместе с содержимым', async () => {
  const f = `/tmp/ragana-hash-${Date.now()}.txt`;
  await writeFile(f, 'первая версия', 'utf8');
  const h1 = await hashFile(f);
  await writeFile(f, 'вторая версия', 'utf8');
  const h2 = await hashFile(f);
  expect(h1).not.toBe(h2);
  expect(h1).toMatch(/^[0-9a-f]{64}$/);
  await rm(f, { force: true });
});

test('имя файла истории — формат из требований', () => {
  const name = searchFileName(new Date(2026, 10, 25, 14, 5, 3, 42));
  expect(name).toBe('2026-11-25---14-05-03---042.json');
  // лексическая сортировка обязана совпадать с хронологической
  const later = searchFileName(new Date(2026, 10, 25, 14, 5, 3, 43));
  expect(later > name).toBe(true);
});

test('🟢 история поиска пишется в формате {промпт: {путь: результат}}', async () => {
  const base = tmp();
  const { layout } = await ensureWorkspace(base);
  const file = await writeSearchLog(layout.searchesDir, 'какая франшиза', [
    { path: 'полис.txt (с. 1)', text: 'Франшиза 300 евро' },
    { path: 'правила.pdf (с. 7)', text: 'Условия выплаты' },
  ]);
  const data = JSON.parse(await Bun.file(file).text());
  expect(Object.keys(data)).toEqual(['какая франшиза']);
  expect(data['какая франшиза']['полис.txt (с. 1)']).toBe('Франшиза 300 евро');
  await rm(base, { recursive: true, force: true });
});

test('несколько фрагментов одного файла склеиваются, а не теряются', async () => {
  const base = tmp();
  const { layout } = await ensureWorkspace(base);
  const file = await writeSearchLog(layout.searchesDir, 'вопрос', [
    { path: 'a.txt', text: 'первый' },
    { path: 'a.txt', text: 'второй' },
  ]);
  const data = JSON.parse(await Bun.file(file).text());
  expect(data['вопрос']['a.txt']).toContain('первый');
  expect(data['вопрос']['a.txt']).toContain('второй');
  await rm(base, { recursive: true, force: true });
});

// ---------- разбор аргументов ----------

test('без аргументов — режим gui', () => {
  expect(parseArgs([]).action).toBe('gui');
});

test('🔴 из нескольких флагов-действий работает ТОЛЬКО ПЕРВЫЙ', () => {
  expect(parseArgs(['--index', '--search', 'x']).action).toBe('index');
  expect(parseArgs(['--search', 'x', '--index']).action).toBe('search');
  expect(parseArgs(['--open', '--gui']).action).toBe('open');
});

test('промпт собирается из слов после --search', () => {
  expect(parseArgs(['--search', 'какая', 'франшиза']).prompt).toBe('какая франшиза');
  expect(parseArgs(['--search', 'в кавычках целиком']).prompt).toBe('в кавычках целиком');
});

test('🔴 модификаторы НЕ считаются действием', () => {
  // иначе `--search "..." --json` не смог бы отдать машиночитаемый вывод,
  // а это основной сценарий в пайплайне
  const p = parseArgs(['--search', 'вопрос', '--json', '--k', '3']);
  expect(p.action).toBe('search');
  expect(p.prompt).toBe('вопрос');
  expect(p.flags.json).toBe(true);
  expect(p.flags.k).toBe('3');
});

test('промпт без флага тоже работает', () => {
  const p = parseArgs(['просто', 'вопрос']);
  expect(p.action).toBe('search');
  expect(p.prompt).toBe('просто вопрос');
});

test('--media и --no-expand разбираются как переключатели', () => {
  const p = parseArgs(['--index', '--media', '--lang', 'rus+deu']);
  expect(p.flags.media).toBe(true);
  expect(p.flags.lang).toBe('rus+deu');
});

test('🔴 ОПЕЧАТКА во флаге отвергается, а не уходит в gui', () => {
  // `--serch "вопрос"` раньше молча становился режимом gui и ждал ввода
  // с клавиатуры — выглядело как зависание и подвесило сборку, а затем
  // и всю песочницу. Неизвестный флаг обязан быть виден.
  const p = parseArgs(['--serch', 'вопрос']);
  expect(p.unknown).toEqual(['--serch']);

  // позитивный контроль: правильный флаг НЕ попадает в unknown
  expect(parseArgs(['--search', 'вопрос']).unknown).toEqual([]);
  expect(parseArgs(['--index', '--json']).unknown).toEqual([]);
  expect(parseArgs(['--index', '--lang', 'rus']).unknown).toEqual([]);
});
