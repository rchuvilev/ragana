// Индексация папки документов.
//
// Порядок работ задан требованиями и важен:
//   1. обход папки, подсчёт хэшей
//   2. сверка с реестром knowledgebase.json -> что добавилось,
//      изменилось, удалилось
//   3. для не-текстовых файлов — расшифровка в <имя>.<ext>.md
//      С КООРДИНАТАМИ (страница либо таймкод)
//   4. чанкинг MD, векторизация, запись в базу
//   5. обновление реестра
//
// Удаление старых фрагментов идёт ДО вставки новых и внутри одной
// транзакции: иначе в выдаче оказались бы обе версии изменённого
// документа.

import { join, dirname } from 'node:path';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { chunkText, verifyOffsets } from '../core/chunk.mjs';
import { asPassage } from '../core/fusion.mjs';
import {
  extractToMarkdown, needsTranscript, transcriptPath,
  parseAnchors, anchorAt, kindOf, type MediaPolicy,
} from './extract.ts';
import {
  scanDocs, hashFile, loadRegistry, saveRegistry, diffRegistry,
  describeDiff, type Layout, type Registry,
} from './workspace.ts';
import { RagStore } from './store.ts';
import type { Chunk, Embedder, Progress } from './types.ts';

export interface IndexOptions {
  ocrLanguages?: string;
  ocrEngine?: 'tesseract' | 'florence' | 'auto';
  media?: MediaPolicy;
  asrModel?: 'tiny' | 'base' | 'small';
  chunkTarget?: number;
  chunkOverlap?: number;
  onProgress?: (p: Progress) => void;
}

export interface IndexReport {
  added: number;
  changed: number;
  removed: number;
  same: number;
  chunksAdded: number;
  chunksRemoved: number;
  warnings: string[];
  summary: string;
  tookMs: number;
}

/**
 * Оценка оставшегося времени по скользящему среднему.
 *
 * Среднее по ВСЕМ обработанным, а не по последнему файлу: размеры
 * документов разнятся на порядки, и оценка по последнему скакала бы
 * так, что ею нельзя было бы пользоваться.
 */
class Eta {
  private started = Date.now();
  private done = 0;

  tick(): void {
    this.done++;
  }

  estimate(total: number): number | undefined {
    if (this.done === 0) return undefined;
    const perItem = (Date.now() - this.started) / this.done;
    return Math.max(0, Math.round((perItem * (total - this.done)) / 1000));
  }
}

export async function runIndex(
  layout: Layout,
  embedder: Embedder,
  opts: IndexOptions = {},
): Promise<IndexReport> {
  const {
    ocrLanguages = 'rus+eng',
    ocrEngine = 'auto',
    media = 'skip',
    asrModel = 'tiny',
    chunkTarget = 900,
    chunkOverlap = 150,
    onProgress,
  } = opts;

  const t0 = Date.now();
  const warnings: string[] = [];
  const store = new RagStore(layout.dbFile, embedder.dim);

  try {
    // Смена модели обесценивает все векторы: они из другого пространства.
    // Молчаливое смешивание сломало бы ранжирование без единой ошибки.
    const modelKey = `e5:${embedder.dim}`;
    const knownModel = store.getMeta('model');
    if (knownModel !== null && knownModel !== modelKey) {
      warnings.push(
        `модель изменилась (${knownModel} -> ${modelKey}), индекс пересобран с нуля`,
      );
      store.clear();
    }
    store.setMeta('model', modelKey);

    onProgress?.({ phase: 'scan', done: 0, total: 0, note: 'обход папки' });
    const files = await scanDocs(layout.docsDir);

    const current = new Map<string, string>();
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      current.set(f.rel, await hashFile(f.abs));
      onProgress?.({
        phase: 'scan', done: i + 1, total: files.length, file: f.rel,
      });
    }

    const registry = await loadRegistry(layout.registryFile);
    const diff = diffRegistry(current, registry);

    // Удаление: сначала чанки из базы, затем расшифровка, затем ключ.
    let chunksRemoved = 0;
    for (const rel of diff.removed) {
      chunksRemoved += store.deleteFile(rel);
      // Расшифровка осиротела — убираем, иначе папка засоряется
      // файлами, которым нечего описывать.
      const md = transcriptPath(join(layout.docsDir, rel));
      try { await unlink(md); } catch { /* её могло и не быть */ }
      delete registry[rel];
    }

    const toIndex = [...diff.added, ...diff.changed];
    const byRel = new Map(files.map((f) => [f.rel, f]));
    const eta = new Eta();
    let chunksAdded = 0;

    for (let i = 0; i < toIndex.length; i++) {
      const rel = toIndex[i]!;
      const file = byRel.get(rel);
      if (!file) continue;

      const report = (phase: Progress['phase'], note?: string) =>
        onProgress?.({
          phase, done: i, total: toIndex.length, file: rel,
          ...(note ? { note } : {}),
          ...(eta.estimate(toIndex.length) !== undefined
            ? { etaSec: eta.estimate(toIndex.length)! } : {}),
        });

      report('extract', 'расшифровка');

      // 1. Текст: либо сам файл, либо его MD-расшифровка
      let sourceText: string;
      let mdPath: string | null = null;
      let method = 'как есть';
      let units = 1;

      if (needsTranscript(rel)) {
        const res = await extractToMarkdown(file.abs, {
          ocrLanguages, ocrEngine, media, asrModel,
          onProgress: (n) => report('extract', n),
        });
        for (const w of res.warnings) warnings.push(`${rel}: ${w}`);
        if (res.markdown.trim().length === 0) {
          // Нечего индексировать — но файл ЗАПОМИНАЕТСЯ в реестре, иначе
          // каждый запуск заново пытался бы его расшифровать.
          registry[rel] = current.get(rel)!;
          eta.tick();
          continue;
        }
        mdPath = transcriptPath(file.abs);
        await mkdir(dirname(mdPath), { recursive: true });
        await writeFile(mdPath, res.markdown, 'utf8');
        sourceText = res.markdown;
        method = res.method;
        units = res.units;
      } else {
        sourceText = await Bun.file(file.abs).text();
      }

      // 2. Чанкинг с привязкой координат.
      //
      // 🔴 Индексируется ТЕЛО расшифровки, а не весь MD. Первая версия
      // брала файл целиком, и в выдачу попадали фрагменты вида
      // «<!-- расшифровка ragana --> # скан.png - источник: /путь/...»,
      // то есть служебная шапка конкурировала с реальным содержимым.
      // Якоря при этом считаются по ПОЛНОМУ тексту, иначе координаты
      // съедут на длину шапки.
      report('chunk', 'разбиение');
      const anchors = parseAnchors(sourceText);
      const bodyFrom = anchors.length > 0 ? anchors[0]!.offset : 0;
      const rawChunks = chunkText(sourceText.slice(bodyFrom), {
        path: rel, target: chunkTarget, overlap: chunkOverlap,
      }).map((c: any) => ({
        ...c,
        // возвращаем смещения в систему координат полного файла
        start: c.start + bodyFrom,
        end: c.end + bodyFrom,
      }));

      const bad = verifyOffsets(sourceText, rawChunks);
      if (bad.length > 0) {
        // Битые координаты обязаны падать сразу: иначе всплывут неверной
        // цитатой через месяц, и причину будет не найти.
        throw new Error(`битые координаты в ${rel}: ${bad[0]}`);
      }

      // 🔴 Заголовки-якоря ВЫРЕЗАЮТСЯ из текста фрагмента: чанкер видит
      // их как обычные строки, и в выдачу утекали обрывки вида «1]»
      // (заголовок разрезало границей чанка). Координата при этом уже
      // извлечена в anchors, так что информация не теряется — она
      // переезжает из текста в поля page/label.
      const stripAnchors = (t: string): string =>
        t.replace(/^#{1,6} \[[^\]]*\]\s*$/gm, '')
         .replace(/^\s*\d+\]\s*$/gm, '')   // хвост разрезанного заголовка
         .replace(/\n{3,}/g, '\n\n')
         .trim();

      const chunks: Chunk[] = rawChunks.map((c: any) => {
        const a = anchorAt(anchors, c.start);
        return {
          id: c.id, path: rel, ord: c.ord, text: stripAnchors(c.text),
          start: c.start, end: c.end,
          ...(a?.page !== undefined ? { page: a.page } : {}),
          ...(a?.startSec !== undefined ? { startSec: a.startSec } : {}),
          ...(a?.endSec !== undefined ? { endSec: a.endSec } : {}),
          ...(a?.label !== undefined ? { label: a.label } : {}),
        };
      });

      // Фрагменты, от которых после вырезания якорей ничего не осталось,
      // выбрасываются: пустая цитата хуже отсутствия цитаты.
      const kept = chunks.filter((c) => c.text.length >= 20);

      // 3. Векторизация пачками по 24 — размер выбран замером
      // (1 текст 227 мс, 12 -> 130, 24 -> 139, 48 -> 128 мс/текст)
      const BATCH = 24;
      const vectors: Float32Array[] = [];
      for (let b = 0; b < kept.length; b += BATCH) {
        const slice = kept.slice(b, b + BATCH);
        report('embed', `${Math.min(b + BATCH, kept.length)}/${kept.length}`);
        const vecs = await embedder.embed(slice.map((c) => asPassage(c.text)));
        vectors.push(...vecs);
      }

      report('store', 'запись');
      store.putChunks(rel, kept, vectors);
      store.putFile({
        rel, hash: current.get(rel)!, size: file.size, mtime: file.mtime,
        kind: kindOf(rel), method, units,
        chunks: kept.length, indexedAt: Date.now(),
      });

      registry[rel] = current.get(rel)!;
      chunksAdded += kept.length;
      eta.tick();
    }

    // Актуализируем хэши неизменившихся: реестр мог отстать, если
    // прошлый запуск прервали на середине.
    for (const rel of diff.same) registry[rel] = current.get(rel)!;

    await saveRegistry(layout.registryFile, registry);
    onProgress?.({ phase: 'done', done: toIndex.length, total: toIndex.length });

    return {
      added: diff.added.length,
      changed: diff.changed.length,
      removed: diff.removed.length,
      same: diff.same.length,
      chunksAdded, chunksRemoved, warnings,
      summary: describeDiff(diff),
      tookMs: Date.now() - t0,
    };
  } finally {
    store.close();
  }
}
