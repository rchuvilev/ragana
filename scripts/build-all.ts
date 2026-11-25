#!/usr/bin/env bun
// Собирает всё, что возможно на текущей машине.
//
// Кросс-сборка бинарей работает: Bun скачивает рантайм нужной платформы.
// Но иконка Windows вшивается только ПРИ СБОРКЕ НА WINDOWS, а бандл .app
// подписывается только на macOS — об этом сообщается по ходу, а не
// замалчивается.

import { C, say, mb, ROOT } from './common.ts';
import { join } from 'node:path';

const STEPS: Array<[string, string[]]> = [
  ['mac:intel', ['scripts/build-desktop.ts', 'mac:intel']],
  ['mac:silicon', ['scripts/build-desktop.ts', 'mac:silicon']],
  ['win', ['scripts/build-desktop.ts', 'win']],
  ['linux', ['scripts/build-desktop.ts', 'linux']],
  ['webpage', ['scripts/build-webpage.ts']],
  ['npm', ['scripts/build-npm.ts']],
  ['plugin', ['scripts/build-plugin.ts']],
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const steps = only.length > 0
  ? STEPS.filter(([id]) => only.includes(id))
  : STEPS;

const results: Array<{ id: string; ok: boolean; note: string }> = [];

for (const [id, args] of steps) {
  say(`\n=== ${id}`);
  const t0 = Date.now();
  const proc = Bun.spawn(['bun', ...args], {
    cwd: ROOT, stdout: 'inherit', stderr: 'inherit',
  });
  const code = await proc.exited;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  results.push({
    id, ok: code === 0,
    note: code === 0 ? `${secs} с` : `код ${code}`,
  });
}

console.log(C.b('\n=== итог'));
let failed = 0;
for (const r of results) {
  const mark = r.ok ? C.g('✓') : C.r('✗');
  console.log(`  ${mark} ${r.id.padEnd(14)} ${r.note}`);
  if (!r.ok) failed++;
}

// Сводка по размерам: полезно сразу видеть, не раздулась ли сборка
const dists = [
  'dist-mac-intel', 'dist-mac-silicon', 'dist-win', 'dist-linux',
  'dist-webpage', 'dist-npm', 'dist-plugin',
];
console.log(C.b('\n=== папки'));
for (const d of dists) {
  const proc = Bun.spawnSync(['du', '-sb', join(ROOT, d)]);
  if (proc.exitCode !== 0) continue;
  const bytes = Number(proc.stdout.toString().split('\t')[0] ?? 0);
  if (bytes > 0) console.log(`  ${d.padEnd(20)} ${mb(bytes)}`);
}

if (failed > 0) {
  console.log(C.r(`\nне собралось целей: ${failed}`));
  process.exit(1);
}
console.log(C.g('\nвсе цели собраны'));
