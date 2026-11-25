// Интерфейс в терминале.
//
// Действия запускают САМ БИНАРЬ дочерним процессом, а не выполняют
// работу внутри. Причины:
//   - индексация идёт минутами и должна прерываться, не роняя интерфейс
//   - падение парсера (битый PDF, экзотический кодек) остаётся в дочернем
//     процессе, а не убивает сессию
//   - прогресс честный: он приходит из того же кода, что работает в CLI,
//     а не из отдельной ветки, которая может разойтись с реальностью

import { createInterface } from 'node:readline';
import type { Layout } from './workspace.ts';
import { RagStore } from './store.ts';
import { humanEta } from './progress.ts';

const C = {
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  c: (s: string) => `\x1b[36m${s}\x1b[0m`,
  inv: (s: string) => `\x1b[7m${s}\x1b[0m`,
};

/** Путь к собственному исполняемому файлу для запуска дочернего процесса. */
function selfCommand(): string[] {
  const exec = process.execPath;
  const isBun = /[\\/]bun(\.exe)?$/.test(exec);
  // В разработке (bun run src/main.ts) надо передать и скрипт,
  // в собранном бинаре — только сам бинарь.
  return isBun ? [exec, 'run', new URL('./main.ts', import.meta.url).pathname] : [exec];
}

interface RunOutcome {
  code: number;
  lastLines: string[];
}

/**
 * Запускает себя же с указанными аргументами и показывает ход работы.
 *
 * Прогресс дочернего процесса идёт в stderr/stdout построчно; мы
 * отображаем последнюю строку, чтобы экран не заливало.
 */
async function runChild(
  args: string[], onLine: (line: string) => void,
): Promise<RunOutcome> {
  const proc = Bun.spawn([...selfCommand(), ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    // Дочерний процесс пишет прогресс только в TTY; здесь его нет,
    // поэтому просим явный построчный режим
    env: { ...process.env, RAGANA_PLAIN_PROGRESS: '1' },
  });

  const lastLines: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (!clean) continue;
        lastLines.push(clean);
        if (lastLines.length > 200) lastLines.shift();
        onLine(clean);
      }
    }
    if (buf.trim()) {
      const clean = buf.replace(/\x1b\[[0-9;]*m/g, '').trim();
      lastLines.push(clean);
      onLine(clean);
    }
  };

  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  const code = await proc.exited;
  return { code, lastLines };
}

function clear(): void {
  process.stdout.write('\x1b[2J\x1b[H');
}

function header(layout: Layout, store: { files: number; chunks: number }): string {
  return [
    C.b('  ragana') + C.dim('  — локальный RAG по вашим документам'),
    '',
    `  ${C.dim('папка')}      ${layout.docsDir}`,
    `  ${C.dim('файлов')}     ${store.files}` +
    `   ${C.dim('фрагментов')} ${store.chunks}`,
    '',
  ].join('\n');
}

const MENU = [
  { key: '1', label: 'Проиндексировать изменения', action: 'index' },
  { key: '2', label: 'Найти по документам', action: 'search' },
  { key: '3', label: 'Открыть папку документов', action: 'open' },
  { key: '4', label: 'Обновить состояние', action: 'status' },
  { key: 'q', label: 'Выход', action: 'quit' },
] as const;

function readStats(layout: Layout): { files: number; chunks: number } {
  try {
    const store = new RagStore(layout.dbFile, 384);
    try {
      return { files: store.fileCount(), chunks: store.chunkCount() };
    } finally {
      store.close();
    }
  } catch {
    return { files: 0, chunks: 0 };
  }
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function runTui(layout: Layout): Promise<number> {
  for (;;) {
    clear();
    const stats = readStats(layout);
    console.log(header(layout, stats));
    for (const m of MENU) {
      console.log(`  ${C.inv(` ${m.key} `)}  ${m.label}`);
    }
    console.log();

    const choice = (await ask('  выбор: ')).trim().toLowerCase();
    const item = MENU.find((m) => m.key === choice);
    if (!item) continue;
    if (item.action === 'quit') {
      clear();
      return 0;
    }

    if (item.action === 'status') continue;

    clear();
    console.log(C.b(`  ${item.label}`));
    console.log();

    let args: string[];
    if (item.action === 'search') {
      const prompt = (await ask('  запрос: ')).trim();
      if (!prompt) continue;
      args = ['--search', prompt];
    } else {
      args = [`--${item.action}`];
    }

    const started = Date.now();
    let spinnerIdx = 0;
    const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const onLine = (line: string) => {
      const elapsed = Math.round((Date.now() - started) / 1000);
      const spin = SPIN[spinnerIdx++ % SPIN.length]!;
      // Оценка времени приходит из самого прогресса; если её нет,
      // показываем хотя бы прошедшее — пользователь видит, что работа идёт
      process.stdout.write(
        `\r\x1b[2K  ${spin} ${line.slice(0, 70)}  ${C.dim(`[${humanEta(elapsed)}]`)}`,
      );
    };

    const { code, lastLines } = await runChild(args, onLine);
    process.stdout.write('\r\x1b[2K');

    // Последние строки — это итог команды, их и показываем
    const tail = lastLines.slice(-14);
    for (const l of tail) console.log(`  ${l}`);
    console.log();
    console.log(code === 0
      ? C.g(`  готово за ${humanEta(Math.round((Date.now() - started) / 1000))}`)
      : C.r(`  завершилось с кодом ${code}`));
    console.log();
    await ask(C.dim('  Enter — в меню '));
  }
}
