#!/usr/bin/env bun
// Сборка npm-пакета: bun scripts/build-npm.ts -> dist-npm/
//
// Пакет содержит ЧЕТЫРЕ бинаря и запускатель, который выбирает нужный по
// платформе — тот же подход, что в claude-plugin-grimoire.
//
// ⚠️ РАЗМЕР: четыре бинаря по ~520 МБ = ~2 ГБ. Для npm это за пределами
// разумного (лимит пакета 2 ГБ, но даже 500 МБ уже неприлично).
// Поэтому по умолчанию собирается ОДНА платформа — текущая, а полный
// набор только по флагу --all, для раздачи через GitHub Releases.

import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TARGETS, ROOT, C, say, mb, version, ensureVendor, freshDist, compile, copy,
} from './common.ts';

const all = process.argv.includes('--all');
const ver = await version();
await ensureVendor();

say(`сборка npm-пакета -> dist-npm${all ? ' (все платформы)' : ' (текущая платформа)'}`);
const dist = await freshDist('dist-npm');
await mkdir(join(dist, 'bin'), { recursive: true });

// Имена бинарей в пакете — платформа в имени, чтобы запускатель находил
// их без догадок.
const BINARIES: Record<string, string> = {
  'mac:intel': 'ragana-darwin-x64',
  'mac:silicon': 'ragana-darwin-arm64',
  win: 'ragana-win32-x64.exe',
  linux: 'ragana-linux-x64',
};

function currentTargetId(): string {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'mac:silicon' : 'mac:intel';
  }
  return 'linux';
}

const ids = all ? Object.keys(TARGETS) : [currentTargetId()];
let total = 0;

for (const id of ids) {
  const target = TARGETS[id]!;
  const name = BINARIES[id]!;
  console.log(C.dim(`  ${id} -> bin/${name}`));
  const built = await compile(
    { ...target, binary: join('bin', name) }, dist,
  );
  if (!name.endsWith('.exe')) await chmod(built.path, 0o755);
  total += built.bytes;
  console.log(`    ${mb(built.bytes)}`);
}

// --- запускатель ---
// Копируется из templates/: писать JS строкой внутри TypeScript — верный
// способ получить ошибку, которая проявится только у пользователя.
await copy(join(ROOT, 'templates', 'launcher-npm.js'), join(dist, 'launcher.js'));
await chmod(join(dist, 'launcher.js'), 0o755);

// --- package.json ---
await Bun.write(join(dist, 'package.json'), JSON.stringify({
  name: 'ragana',
  version: ver,
  description: 'Локальный RAG по вашим документам: цитаты со страницей и таймкодом. Всё внутри одного файла.',
  keywords: ['rag', 'search', 'embeddings', 'ocr', 'offline', 'local', 'cli'],
  license: 'MIT',
  author: 'hexstack',
  repository: { type: 'git', url: 'git+https://github.com/hexstack-apps/ragana.git' },
  homepage: 'https://github.com/hexstack-apps/ragana#readme',
  bin: { ragana: './launcher.js' },
  files: ['launcher.js', 'bin/', 'README.md', 'ТРЕБОВАНИЯ.md'],
  engines: { node: '>=18' },
  os: ['darwin', 'linux', 'win32'],
  cpu: ['x64', 'arm64'],
}, null, 2));

await copy(join(ROOT, 'README.md'), join(dist, 'README.md'));

await Bun.write(join(dist, 'ТРЕБОВАНИЯ.md'), [
  '# Системные зависимости',
  '',
  'Модель и рантайм внутри бинаря. Для части форматов нужны утилиты:',
  '',
  '```sh',
  '# Debian/Ubuntu',
  'sudo apt install tesseract-ocr tesseract-ocr-rus poppler-utils ffmpeg imagemagick',
  '# macOS',
  'brew install tesseract tesseract-lang poppler ffmpeg imagemagick',
  '```',
  '',
  'Текст, Markdown и CSV работают без них.',
  '',
].join('\n'));

console.log(C.g(`\nготово: dist-npm/ (бинарей ${ids.length}, ${mb(total)})`));
if (!all) {
  console.log(C.dim('  для всех платформ: bun scripts/build-npm.ts --all'));
}
if (total > 100 * 1024 * 1024) {
  console.log(C.y(`  ВНИМАНИЕ: ${mb(total)} — велико для npm, раздавайте через Releases`));
}
