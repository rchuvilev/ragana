#!/usr/bin/env bun
// Сборка одной десктопной цели: bun scripts/build-desktop.ts <цель>
//
// Отдельный скрипт на все четыре платформы, а не четыре копии: разница
// между ними исчерпывается полем bunTarget и сопутствующими файлами
// (иконка, .desktop, .app). Дублировать ради этого 4 файла — значит
// чинить потом ошибку в четырёх местах.

import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TARGETS, ROOT, C, say, mb, version, ensureVendor, freshDist, compile, copy,
} from './common.ts';

const id = process.argv[2];
const target = id ? TARGETS[id] : undefined;

if (!target) {
  console.error(C.r(`укажите цель: ${Object.keys(TARGETS).join(' | ')}`));
  process.exit(2);
}

const ver = await version();
await ensureVendor();

say(`сборка ${target.id} -> ${target.dist}`);
const dist = await freshDist(target.dist);

// 🔴 --windows-icon РАБОТАЕТ ТОЛЬКО ПРИ СБОРКЕ НА WINDOWS:
// 'error: Using --windows-icon is only available when compiling on Windows'.
// Проверено попыткой кросс-сборки отсюда. Поэтому при сборке не на
// Windows иконка не вшивается, а в папку кладётся .ico и готовая
// команда rcedit — молча выдавать бинарь без иконки нельзя.
const onWindows = process.platform === 'win32';
const extra: string[] = [];
if (target.id === 'win' && onWindows) {
  extra.push(
    `--windows-icon=${join(ROOT, 'assets', 'ragana.ico')}`,
    '--windows-title=ragana',
    '--windows-publisher=hexstack',
    `--windows-version=${ver}.0`,
    '--windows-description=Локальный RAG по вашим документам',
  );
}

const built = await compile(target, dist, extra);
if (!target.binary.endsWith('.exe')) await chmod(built.path, 0o755);
console.log(`  ${target.binary}  ${mb(built.bytes)}`);

// --- сопутствующие файлы под платформу ---

if (target.id === 'win') {
  await copy(join(ROOT, 'assets', 'ragana.ico'), join(dist, 'ragana.ico'));
  if (!onWindows) {
    console.log(C.y('  иконка НЕ вшита: --windows-icon доступен только на Windows'));
    await Bun.write(join(dist, 'set-icon.cmd'), [
      '@echo off',
      'REM Вшивает иконку в уже собранный .exe.',
      'REM Нужно, потому что bun умеет это только при сборке НА Windows.',
      `npx rcedit ragana.exe --set-icon ragana.ico ^`,
      `  --set-version-string ProductName ragana ^`,
      `  --set-version-string CompanyName hexstack ^`,
      `  --set-file-version ${ver}.0`,
      '',
    ].join('\r\n'));
    console.log(C.dim('  добавлен set-icon.cmd — запустить на Windows'));
  }
}

if (target.id.startsWith('mac')) {
  // У Mach-O нет секции ресурсов, иконку несёт бандл .app
  const app = join(dist, 'ragana.app');
  const proc = Bun.spawn(
    ['sh', join(ROOT, 'tools', 'make-app.sh'), built.path, app],
    { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
  );
  await proc.exited;
}

if (target.id === 'linux') {
  // У ELF тоже нет места под иконку — её несёт ярлык .desktop
  await Bun.write(join(dist, 'ragana.desktop'), [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=ragana',
    'GenericName=Локальный поиск по документам',
    'Comment=RAG по вашим файлам: цитаты со страницей и таймкодом',
    'Exec=ragana --gui',
    'Icon=ragana',
    'Terminal=true',
    'Categories=Utility;Office;',
    'Keywords=rag;search;документы;поиск;',
    '',
  ].join('\n'));
  await copy(join(ROOT, 'assets', 'ragana.png'), join(dist, 'ragana.png'));
  await Bun.write(join(dist, 'install.sh'), [
    '#!/bin/sh',
    '# Устанавливает ragana в пользовательские каталоги.',
    'set -e',
    'mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"',
    'mkdir -p "$HOME/.local/share/icons/hicolor/256x256/apps"',
    'install -m 755 ragana "$HOME/.local/bin/ragana"',
    'install -m 644 ragana.png "$HOME/.local/share/icons/hicolor/256x256/apps/ragana.png"',
    'install -m 644 ragana.desktop "$HOME/.local/share/applications/ragana.desktop"',
    'command -v update-desktop-database >/dev/null && \\',
    '  update-desktop-database "$HOME/.local/share/applications" || true',
    'echo "установлено: ~/.local/bin/ragana"',
    '',
  ].join('\n'));
  await chmod(join(dist, 'install.sh'), 0o755);
}

// Системные зависимости указываются в каждой папке: без tesseract и
// ffmpeg часть форматов не обработается, и узнать об этом лучше заранее.
await Bun.write(join(dist, 'ТРЕБОВАНИЯ.md'), [
  '# Системные зависимости',
  '',
  'Модель, рантайм и Florence-2 **внутри бинаря** — скачивать нечего.',
  'Но для части форматов нужны системные утилиты:',
  '',
  '| утилита | для чего | без неё |',
  '|---|---|---|',
  '| `tesseract` + языки | текст на картинках и сканах | картинки не индексируются |',
  '| `pdftotext`, `pdftoppm` | PDF | PDF не индексируется |',
  '| `ffmpeg` | аудио и видео | медиа не расшифровывается |',
  '| `magick` | подготовка изображений для Florence-2 | нет описаний картинок |',
  '',
  '```sh',
  '# Debian/Ubuntu',
  'sudo apt install tesseract-ocr tesseract-ocr-rus poppler-utils ffmpeg imagemagick',
  '# macOS',
  'brew install tesseract tesseract-lang poppler ffmpeg imagemagick',
  '# Windows (scoop)',
  'scoop install tesseract poppler ffmpeg imagemagick',
  '```',
  '',
  'Текстовые файлы (txt, md, csv, html) работают без каких-либо утилит.',
  '',
].join('\n'));

console.log(C.g(`\nготово: ${target.dist}/`));
