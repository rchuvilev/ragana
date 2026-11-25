#!/usr/bin/env node
// Выбирает бинарь ragana под текущую платформу и запускает его.
//
// 🔴 ESM, а не CommonJS: при "type":"module" в package.json рядом файл
// .js трактуется как ES-модуль, и require падает с 'require is not
// defined in ES module scope'. Поймано запуском плагина из его папки.
import { spawn } from 'node:child_process';
import { existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const BINARIES = {
  'darwin-arm64': 'ragana-mac',
  'darwin-x64':   'ragana-mac-intel',
  'linux-x64':    'ragana-linux',
  'linux-arm64':  'ragana-linux',
  'win32-x64':    'ragana-win.exe',
};

const key = `${process.platform}-${process.arch}`;
const name = BINARIES[key];

if (!name) {
  console.error(`ragana: платформа ${key} не поддерживается`);
  console.error('поддерживаются: ' + Object.keys(BINARIES).join(', '));
  process.exit(1);
}

const bin = join(HERE, name);

if (!existsSync(bin)) {
  // Частый случай: пакет собран под одну платформу, ставится на другую.
  // Сообщаем прямо, а не падаем с ENOENT из spawn.
  console.error(`ragana: нет бинаря для ${key}`);
  console.error(`ожидался файл: ${bin}`);
  console.error('скачайте сборку: https://github.com/hexstack-apps/ragana/releases');
  process.exit(1);
}

// npm и архиваторы теряют бит исполняемости на части систем
if (process.platform !== 'win32') {
  try { chmodSync(bin, 0o755); } catch { /* уже исполняемый */ }
}

const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit' });
child.on('error', (err) => {
  console.error('ragana: не удалось запустить:', err.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
