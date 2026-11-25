// Общее для всех скриптов сборки.
//
// Каждая цель собирается в СВОЮ папку dist-*, чтобы сборки не затирали
// друг друга: иначе параллельный запуск двух целей даёт бинарь от одной
// с именем от другой, и понять это можно только по размеру.

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

export interface Target {
  /** Имя npm-скрипта без префикса build: */
  id: string;
  /** Папка назначения. */
  dist: string;
  /** Цель bun build --target, либо null для текущей системы. */
  bunTarget: string | null;
  /** Имя исполняемого файла внутри dist. */
  binary: string;
}

export const TARGETS: Record<string, Target> = {
  'mac:intel': {
    id: 'mac:intel', dist: 'dist-mac-intel',
    bunTarget: 'bun-darwin-x64', binary: 'ragana',
  },
  'mac:silicon': {
    id: 'mac:silicon', dist: 'dist-mac-silicon',
    bunTarget: 'bun-darwin-arm64', binary: 'ragana',
  },
  win: {
    id: 'win', dist: 'dist-win',
    bunTarget: 'bun-windows-x64', binary: 'ragana.exe',
  },
  linux: {
    id: 'linux', dist: 'dist-linux',
    bunTarget: 'bun-linux-x64', binary: 'ragana',
  },
};

export const C = {
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

export function say(msg: string): void {
  console.log(C.b(msg));
}

export function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} МБ`;
}

/** Версия из package.json — один источник правды для всех сборок. */
export async function version(): Promise<string> {
  const pkg = await Bun.file(join(ROOT, 'package.json')).json();
  return pkg.version ?? '0.0.0';
}

/** Готовит vendor/ — без него сборка упадёт на отсутствующем ort-common. */
export async function ensureVendor(): Promise<void> {
  const marker = join(ROOT, 'vendor', 'ort-common.mjs');
  if (await Bun.file(marker).exists()) return;
  say('подготовка vendor/');
  const proc = Bun.spawn(['sh', join(ROOT, 'tools', 'vendor.sh')], {
    cwd: ROOT, stdout: 'inherit', stderr: 'inherit',
  });
  if ((await proc.exited) !== 0) throw new Error('не удалось собрать vendor/');
}

/** Чистая папка назначения. */
export async function freshDist(dist: string): Promise<string> {
  const dir = join(ROOT, dist);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

export interface BuildResult {
  path: string;
  bytes: number;
}

/**
 * Собирает один бинарь.
 *
 * Проверяется не факт создания файла, а его размер: при ошибке
 * компиляции bun может оставить обрезанный файл, и `ls` покажет его как
 * существующий.
 */
export async function compile(
  target: Target, dist: string, extraArgs: string[] = [],
): Promise<BuildResult> {
  const out = join(dist, target.binary);
  const args = [
    'build', 'src/main.ts', '--compile', '--minify',
    ...(target.bunTarget ? [`--target=${target.bunTarget}`] : []),
    ...extraArgs,
    '--outfile', out,
  ];

  const proc = Bun.spawn(['bun', ...args], {
    cwd: ROOT, stdout: 'inherit', stderr: 'inherit',
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`сборка ${target.id} завершилась с ошибкой`);
  }

  const file = Bun.file(out);
  if (!(await file.exists())) throw new Error(`нет файла: ${out}`);
  // Нижняя граница: пустой рантайм Bun весит ~75 МБ, поэтому всё, что
  // меньше 50 МБ, — заведомо обрезанная сборка.
  if (file.size < 50 * 1024 * 1024) {
    throw new Error(`подозрительно малый бинарь: ${mb(file.size)}`);
  }
  return { path: out, bytes: file.size };
}

/** Копирует файл, создавая каталоги. */
export async function copy(from: string, to: string): Promise<void> {
  await mkdir(join(to, '..'), { recursive: true }).catch(() => {});
  await Bun.write(to, Bun.file(from));
}
