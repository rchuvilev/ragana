// Команды приложения — по функции на каждую.
//
// Вынесено из main(), где они жили одним switch на 191 строку. Причина не
// в эстетике: при такой длине невозможно увидеть, что делает отдельная
// команда, не прокручивая соседние, а общие переменные начинают
// просачиваться между ветками.
//
// Каждая команда возвращает КОД ВОЗВРАТА: инструмент предназначен для
// пайплайнов, где вызывающий скрипт обязан отличить «не найдено» (4) от
// «индекс пуст» (3) и от настоящей ошибки (1).

import { C } from './colors.ts';
import { RagStore } from './store.ts';
import { writeSearchLog, type Layout } from './workspace.ts';
import type { Embedder } from './types.ts';

/** Коды возврата — часть контракта для пайплайнов. */
export const EXIT = {
  ok: 0,
  error: 1,
  badUsage: 2,
  emptyIndex: 3,
  notFound: 4,
} as const;

export interface CommandContext {
  layout: Layout;
  flags: Record<string, string | boolean>;
  makeEmbedder: (dbFile: string) => Promise<Embedder>;
}

const str = (v: unknown, fallback: string): string =>
  typeof v === 'string' ? v : fallback;

// ---------- открыть папку ----------

export async function cmdOpen({ layout }: CommandContext): Promise<number> {
  const { openFolder } = await import('./open.ts');
  const r = await openFolder(layout.docsDir);
  if (!r.ok) {
    console.error(C.r(`не удалось открыть: ${r.error}`));
    // Путь печатается даже при отказе: пользователь откроет вручную
    console.log(layout.docsDir);
    return EXIT.error;
  }
  console.log(C.g(`открыто: ${layout.docsDir}`));
  return EXIT.ok;
}

// ---------- состояние ----------

export async function cmdStatus({ layout, flags }: CommandContext): Promise<number> {
  const store = new RagStore(layout.dbFile, 384);
  try {
    const files = store.fileCount();
    const chunks = store.chunkCount();

    if (flags.json) {
      console.log(JSON.stringify({
        root: layout.root,
        docsDir: layout.docsDir,
        files, chunks,
        model: store.getMeta('model'),
      }, null, 2));
      return EXIT.ok;
    }

    console.log(`${C.b('папка')}      ${layout.docsDir}`);
    console.log(`${C.b('файлов')}     ${files}`);
    console.log(`${C.b('фрагментов')} ${chunks}`);
    if (files === 0) {
      console.log(C.y('\nпусто — положите документы и запустите ragana --index'));
    }
    return EXIT.ok;
  } finally {
    store.close();
  }
}

// ---------- индексация ----------

export async function cmdIndex(ctx: CommandContext): Promise<number> {
  const { layout, flags, makeEmbedder } = ctx;
  const { runIndex } = await import('./indexer.ts');
  const { renderProgress } = await import('./progress.ts');

  process.stdout.write('загрузка модели... ');
  const t0 = Date.now();
  const embedder = await makeEmbedder(layout.dbFile);
  console.log(C.dim(`${((Date.now() - t0) / 1000).toFixed(1)} с`));

  const report = await runIndex(layout, embedder, {
    ocrLanguages: str(flags.lang, 'rus+eng'),
    ocrEngine: str(flags.ocr, 'auto') as 'tesseract' | 'florence' | 'auto',
    media: flags.media ? 'transcribe' : 'skip',
    asrModel: str(flags.asr, 'tiny') as 'tiny' | 'base' | 'small',
    ...(flags.quiet ? {} : { onProgress: renderProgress }),
  });

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return EXIT.ok;
  }

  console.log(C.g('готово: ') + report.summary);
  console.log(C.dim(
    `фрагментов +${report.chunksAdded} -${report.chunksRemoved}, `
    + `время ${(report.tookMs / 1000).toFixed(1)} с`,
  ));
  // Предупреждения ограничены десятью: на большом архиве их могут быть
  // сотни, и они вытеснят с экрана сам результат
  for (const w of report.warnings.slice(0, 10)) console.log(C.y(`  ! ${w}`));
  if (report.warnings.length > 10) {
    console.log(C.dim(`  ещё ${report.warnings.length - 10} предупреждений`));
  }
  return EXIT.ok;
}

// ---------- поиск ----------

export async function cmdSearch(ctx: CommandContext, prompt: string): Promise<number> {
  const { layout, flags, makeEmbedder } = ctx;

  if (!prompt) {
    console.error(C.r('нужен запрос: ragana --search "ваш вопрос"'));
    return EXIT.badUsage;
  }

  const store = new RagStore(layout.dbFile, 384);
  try {
    if (store.chunkCount() === 0) {
      console.error(C.y('индекс пуст — сначала ragana --index'));
      return EXIT.emptyIndex;
    }

    const embedder = await makeEmbedder(layout.dbFile);
    const { Searcher, sourceOf } = await import('./search.ts');
    const searcher = new Searcher(store, embedder);
    searcher.setDocsDir(layout.docsDir);

    // Словарь из корпуса — по флагу: на малом корпусе он УХУДШАЕТ
    // ранжирование (замерено: MRR 0.89 -> 0.85), потому что статистика
    // не отличает термин от служебного слова.
    if (flags.cooc) {
      const { Cooccurrence } = await import('./cooccurrence.ts');
      searcher.setCooccurrence(new Cooccurrence(layout.dbFile));
    }

    const res = await searcher.search(prompt, {
      k: Number(flags.k ?? 5),
      expand: flags['no-expand'] !== true,
      mode: str(flags.mode, 'hybrid') as 'hybrid' | 'vector' | 'lexical',
      ...(flags['min-score'] ? { minScore: Number(flags['min-score']) } : {}),
    });

    const logFile = await writeSearchLog(
      layout.searchesDir, prompt,
      res.citations.map((c) => ({ path: sourceOf(c.chunk), text: c.chunk.text })),
    );

    if (flags.json) {
      console.log(JSON.stringify({
        prompt: res.prompt,
        query: res.query,
        queries: res.queries,
        added: res.added,
        tookMs: res.tookMs,
        log: logFile,
        citations: res.citations.map((c) => ({
          path: c.chunk.path,
          label: c.chunk.label ?? null,
          page: c.chunk.page ?? null,
          startSec: c.chunk.startSec ?? null,
          endSec: c.chunk.endSec ?? null,
          score: c.score,
          via: c.via,
          text: c.chunk.text,
        })),
      }, null, 2));
      return res.citations.length > 0 ? EXIT.ok : EXIT.notFound;
    }

    // Разбиение показывается: иначе выдача по составному вопросу
    // выглядит необъяснимой
    if (res.queries.length > 1) {
      console.log(C.dim(`разбито на ${res.queries.length}: ${res.queries.join(' | ')}`));
    }
    if (res.added.length) console.log(C.dim(`+ ${res.added.join(' ')}`));

    if (res.citations.length === 0) {
      console.log(C.y('ничего не найдено'));
      return EXIT.notFound;
    }

    console.log();
    res.citations.forEach((c, i) => {
      const via = c.via === 'hybrid' ? C.g('оба')
        : c.via === 'lexical' ? C.y('слова') : C.c('смысл');
      console.log(
        `${C.b(`[${i + 1}]`)} ${C.b(sourceOf(c.chunk))}  `
        + C.dim(`${via} ${c.score.toFixed(4)}`),
      );
      console.log(`    ${c.chunk.text.replace(/\n/g, '\n    ')}`);
      console.log();
    });
    console.log(C.dim(`${res.citations.length} цитат за ${res.tookMs} мс · ${logFile}`));
    if (res.dropped.length) {
      console.log(C.r(`висячих ссылок: ${res.dropped.length} — переиндексируйте`));
    }
    return EXIT.ok;
  } finally {
    store.close();
  }
}

// ---------- сброс ----------

export async function cmdReset({ layout }: CommandContext): Promise<number> {
  const { rm } = await import('node:fs/promises');
  // Удаляется только база и реестр: документы пользователя не трогаем
  // ни при каких условиях.
  await rm(layout.dbFile, { force: true });
  await rm(`${layout.dbFile}-wal`, { force: true });
  await rm(`${layout.dbFile}-shm`, { force: true });
  await Bun.write(layout.registryFile, '{}\n');
  console.log(C.g('индекс сброшен') + C.dim(' (документы не тронуты)'));
  return EXIT.ok;
}
