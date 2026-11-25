#!/usr/bin/env bun
// ragana — точка входа.
//
// Требования по флагам:
//   --index           переиндексация папки
//   --search <промпт> RAG-поиск
//   --open            открыть папку документов
//   --gui             TUI
// Если флагов несколько — действует ТОЛЬКО ПЕРВЫЙ.
// Без флагов (или запуск кликом) = --gui.

import { ensureWorkspace, writeSearchLog, layoutOf } from './workspace.ts';
import { RagStore } from './store.ts';
import type { Embedder } from './types.ts';

const C = {
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  c: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

/** Действия в порядке приоритета: первый встреченный флаг побеждает. */
const ACTIONS = ['index', 'search', 'open', 'gui', 'status', 'help'] as const;
export type Action = (typeof ACTIONS)[number];

export interface ParsedArgs {
  action: Action;
  /** Промпт для --search: всё, что идёт после флага. */
  prompt: string;
  flags: Record<string, string | boolean>;
  /** Флаги, которых мы не знаем — повод отказать, а не угадывать. */
  unknown: string[];
}

/**
 * Разбор аргументов.
 *
 * «Используется только первый флаг» понимается как первый флаг-ДЕЙСТВИЕ:
 * модификаторы (--json, --media, --k) остаются в силе, иначе
 * `--search "..." --json` не смог бы отдать машиночитаемый вывод, а это
 * основной сценарий использования в пайплайне.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  let action: Action | null = null;
  let prompt = '';
  const rest: string[] = [];

  const BOOLEAN = new Set([
    'json', 'quiet', 'no-expand', 'help', 'version', 'media', 'force',
  ]);
  const VALUED = new Set(['k', 'mode', 'asr', 'lang', 'home', 'pool', 'ocr']);
  const unknown: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const key = a.slice(2);

    if ((ACTIONS as readonly string[]).includes(key)) {
      // Первое действие фиксируется, последующие игнорируются.
      if (action === null) {
        action = key as Action;
        if (key === 'search') {
          // Промпт — всё до следующего флага, чтобы работало и
          // --search "фраза", и --search слово другое
          const words: string[] = [];
          while (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) {
            words.push(argv[++i]!);
          }
          prompt = words.join(' ');
        }
      }
      continue;
    }

    if (BOOLEAN.has(key)) {
      flags[key] = true;
    } else if (VALUED.has(key)) {
      if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) {
        flags[key] = argv[++i]!;
      } else {
        flags[key] = true;
      }
    } else {
      // 🔴 Опечатка в флаге НЕ должна молча запускать другой режим.
      // `--serch "вопрос"` уходил в gui и ждал ввода с клавиатуры, то
      // есть выглядел как зависание — и подвесил сборку на позитивном
      // контроле в tools/build.sh, а затем и всю песочницу.
      unknown.push(`--${key}`);
    }
  }

  // Промпт без флага: `ragana "вопрос"` удобнее, чем требовать --search
  if (action === null && rest.length > 0) {
    action = 'search';
    prompt = rest.join(' ');
  }

  return { action: action ?? 'gui', prompt, flags, unknown };
}

function helpText(): string {
  return `${C.b('ragana')} — локальный RAG по вашим документам

  ${C.c('ragana --index')}              проиндексировать изменения
  ${C.c('ragana --search "вопрос"')}    найти с цитатами
  ${C.c('ragana --open')}               открыть папку документов
  ${C.c('ragana --gui')}                интерфейс в терминале
  ${C.c('ragana --status')}             что в индексе

${C.dim('Без флагов запускается --gui.')}
${C.dim('Если флагов действия несколько — работает только первый.')}

${C.b('Модификаторы')}
  --json             машиночитаемый вывод (для пайплайна)
  --k <N>            сколько цитат (по умолчанию 5)
  --mode <режим>     hybrid | vector | lexical
  --no-expand        не расширять запрос синонимами
  --media            расшифровывать аудио и видео (долго!)
  --asr <модель>     tiny | base | small (по умолчанию tiny)
  --lang <языки>     языки OCR, например rus+eng+deu
  --ocr <движок>     tesseract | florence | auto (по умолчанию auto)
  --home <путь>      другой каталог рабочего места

${C.b('В пайплайне')}
  ragana --search "условия возврата" --json \\
    | jq -r '.citations[].text' \\
    | claude -p "Ответь по этим выдержкам"`;
}

/**
 * Эмбеддер поверх кэша.
 *
 * Загрузка модели стоит 6-7.7 с — это ~30 эмбеддингов, то есть для CLI
 * доминирующая статья расходов. Кэш (измерено: 136x на повторе) снимает
 * её для повторяющихся текстов.
 */
async function makeEmbedder(dbFile: string): Promise<Embedder> {
  const { createEmbedder } = await import('./embedder.ts');
  const raw = await createEmbedder();
  const { EmbeddingCache, withCache } = await import('./cache.ts');
  const cache = new EmbeddingCache(dbFile, 'multilingual-e5-small', raw.dim);
  return withCache(raw, cache);
}

async function main(): Promise<number> {
  const { action, prompt, flags, unknown } = parseArgs(process.argv.slice(2));

  if (unknown.length > 0) {
    console.error(C.r(`неизвестные флаги: ${unknown.join(' ')}`));
    console.error(C.dim('подсказка: ragana --help'));
    return 2;
  }

  if (action === 'help' || flags.help) {
    console.log(helpText());
    return 0;
  }

  const base = typeof flags.home === 'string' ? flags.home : undefined;
  const { layout, created } = await ensureWorkspace(base);

  if (created) {
    console.log(C.g('создано рабочее место:'));
    console.log(`  ${layout.root}`);
    console.log(C.dim(`  документы кладите в ${layout.docsDir}`));
  }

  switch (action) {
    case 'open': {
      const { openFolder } = await import('./open.ts');
      const r = await openFolder(layout.docsDir);
      if (!r.ok) {
        console.error(C.r(`не удалось открыть: ${r.error}`));
        console.log(`путь: ${layout.docsDir}`);
        return 1;
      }
      console.log(C.g(`открыто: ${layout.docsDir}`));
      return 0;
    }

    case 'status': {
      const store = new RagStore(layout.dbFile, 384);
      try {
        const files = store.fileCount();
        const chunks = store.chunkCount();
        if (flags.json) {
          console.log(JSON.stringify({
            root: layout.root, docsDir: layout.docsDir,
            files, chunks, model: store.getMeta('model'),
          }, null, 2));
        } else {
          console.log(`${C.b('папка')}    ${layout.docsDir}`);
          console.log(`${C.b('файлов')}   ${files}`);
          console.log(`${C.b('фрагментов')} ${chunks}`);
          if (files === 0) {
            console.log(C.y('\nпусто — положите документы и запустите ragana --index'));
          }
        }
        return 0;
      } finally {
        store.close();
      }
    }

    case 'index': {
      const { runIndex } = await import('./indexer.ts');
      const { renderProgress } = await import('./progress.ts');

      process.stdout.write('загрузка модели... ');
      const t0 = Date.now();
      const embedder = await makeEmbedder(layout.dbFile);
      console.log(C.dim(`${((Date.now() - t0) / 1000).toFixed(1)} с`));

      const report = await runIndex(layout, embedder, {
        ocrLanguages: typeof flags.lang === 'string' ? flags.lang : 'rus+eng',
        ocrEngine: (typeof flags.ocr === 'string' ? flags.ocr : 'auto') as any,
        media: flags.media ? 'transcribe' : 'skip',
        asrModel: (typeof flags.asr === 'string' ? flags.asr : 'tiny') as any,
        onProgress: flags.quiet ? undefined : renderProgress,
      });

      if (flags.json) {
        console.log(JSON.stringify(report, null, 2));
        return 0;
      }

      console.log(C.g('готово: ') + report.summary);
      console.log(C.dim(
        `фрагментов +${report.chunksAdded} -${report.chunksRemoved}, ` +
        `время ${(report.tookMs / 1000).toFixed(1)} с`,
      ));
      for (const w of report.warnings.slice(0, 10)) console.log(C.y(`  ! ${w}`));
      if (report.warnings.length > 10) {
        console.log(C.dim(`  ещё ${report.warnings.length - 10} предупреждений`));
      }
      return 0;
    }

    case 'search': {
      if (!prompt) {
        console.error(C.r('нужен запрос: ragana --search "ваш вопрос"'));
        return 2;
      }
      const store = new RagStore(layout.dbFile, 384);
      try {
        if (store.chunkCount() === 0) {
          console.error(C.y('индекс пуст — сначала ragana --index'));
          return 3;
        }
        const embedder = await makeEmbedder(layout.dbFile);
        const { Searcher, sourceOf } = await import('./search.ts');
        const searcher = new Searcher(store, embedder);
        searcher.setDocsDir(layout.docsDir);

        const res = await searcher.search(prompt, {
          k: Number(flags.k ?? 5),
          expand: flags['no-expand'] !== true,
          mode: (typeof flags.mode === 'string' ? flags.mode : 'hybrid') as any,
        });

        // История поиска — требование: файл на каждый запуск
        const logFile = await writeSearchLog(
          layout.searchesDir, prompt,
          res.citations.map((c) => ({
            path: sourceOf(c.chunk), text: c.chunk.text,
          })),
        );

        if (flags.json) {
          console.log(JSON.stringify({
            prompt: res.prompt, query: res.query, added: res.added,
            tookMs: res.tookMs, log: logFile,
            citations: res.citations.map((c) => ({
              path: c.chunk.path,
              label: c.chunk.label ?? null,
              page: c.chunk.page ?? null,
              startSec: c.chunk.startSec ?? null,
              endSec: c.chunk.endSec ?? null,
              score: c.score, via: c.via, text: c.chunk.text,
            })),
          }, null, 2));
          return res.citations.length > 0 ? 0 : 4;
        }

        if (res.added.length) console.log(C.dim(`+ ${res.added.join(' ')}`));
        if (res.citations.length === 0) {
          console.log(C.y('ничего не найдено'));
          return 4;
        }
        console.log();
        res.citations.forEach((c, i) => {
          const via = c.via === 'hybrid' ? C.g('оба')
            : c.via === 'lexical' ? C.y('слова') : C.c('смысл');
          console.log(`${C.b(`[${i + 1}]`)} ${C.b(sourceOf(c.chunk))}  ${C.dim(`${via} ${c.score.toFixed(4)}`)}`);
          console.log(`    ${c.chunk.text.replace(/\n/g, '\n    ')}`);
          console.log();
        });
        console.log(C.dim(`${res.citations.length} цитат за ${res.tookMs} мс · ${logFile}`));
        return 0;
      } finally {
        store.close();
      }
    }

    case 'gui': {
      const { runTui } = await import('./tui.ts');
      return runTui(layout);
    }

    default:
      console.log(helpText());
      return 0;
  }
}

if (import.meta.main) {
  main()
    .then((code) => { process.exit(code); })
    .catch((e: unknown) => {
      console.error(C.r('ошибка: ') + ((e as Error)?.message ?? String(e)));
      process.exit(1);
    });
}
