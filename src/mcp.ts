// MCP-сервер поверх stdio.
//
// Зачем, когда есть CLI с --json: модель не должна разбирать текстовый
// вывод и угадывать формат. MCP даёт типизированный контракт — описание
// инструмента, схему аргументов и структурированный ответ. Это и есть
// главная цель проекта: подключаться к любой модели в пайплайн.
//
// Протокол реализован вручную, без SDK: нужны ровно три метода
// (initialize, tools/list, tools/call), а зависимость пришлось бы
// вшивать в бинарь ради сотни строк.

import { ensureWorkspace, writeSearchLog } from './workspace.ts';
import { RagStore } from './store.ts';
import type { Embedder } from './types.ts';

interface Request {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'search_documents',
    description:
      'Поиск по локальным документам пользователя с дословными цитатами. '
      + 'Возвращает выдержки с путём к файлу и координатой: номером страницы '
      + 'для PDF и изображений, таймкодом для аудио и видео. Применяй, когда '
      + 'вопрос касается содержимого файлов пользователя.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Вопрос на естественном языке' },
        limit: {
          type: 'integer', description: 'Сколько цитат вернуть (по умолчанию 5)',
          minimum: 1, maximum: 20,
        },
        mode: {
          type: 'string', enum: ['hybrid', 'vector', 'lexical'],
          description: 'Способ поиска: hybrid (по умолчанию), vector — по смыслу, lexical — по словам',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'index_status',
    description:
      'Состояние локальной базы: сколько файлов и фрагментов проиндексировано, '
      + 'где лежит папка документов.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

function reply(id: Request['id'], result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function fail(id: Request['id'], code: number, message: string): void {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n',
  );
}

/** Текстовый ответ инструмента в формате MCP. */
function toolText(text: string, isError = false): unknown {
  return { content: [{ type: 'text', text }], isError };
}

export async function runMcp(makeEmbedder: (db: string) => Promise<Embedder>): Promise<number> {
  const { layout } = await ensureWorkspace(
    process.env.RAGANA_HOME ?? undefined,
  );

  // Эмбеддер поднимается ЛЕНИВО: загрузка модели стоит 6-7 с, и платить
  // их при вызове index_status, которому модель не нужна, незачем.
  let embedder: Embedder | null = null;
  const getEmbedder = async (): Promise<Embedder> => {
    embedder ??= await makeEmbedder(layout.dbFile);
    return embedder;
  };

  const handle = async (req: Request): Promise<void> => {
    switch (req.method) {
      case 'initialize':
        reply(req.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'ragana', version: '0.1.0' },
        });
        return;

      case 'notifications/initialized':
        return; // уведомление, ответа не требует

      case 'tools/list':
        reply(req.id, { tools: TOOLS });
        return;

      case 'tools/call': {
        const name = String(req.params?.name ?? '');
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;

        if (name === 'index_status') {
          const store = new RagStore(layout.dbFile, 384);
          try {
            reply(req.id, toolText(JSON.stringify({
              docsDir: layout.docsDir,
              files: store.fileCount(),
              chunks: store.chunkCount(),
            }, null, 2)));
          } finally {
            store.close();
          }
          return;
        }

        if (name === 'search_documents') {
          const query = String(args.query ?? '').trim();
          if (!query) {
            reply(req.id, toolText('Пустой запрос', true));
            return;
          }

          const store = new RagStore(layout.dbFile, 384);
          try {
            if (store.chunkCount() === 0) {
              // Честное указание на причину вместо пустого результата:
              // модель должна сказать пользователю, что делать.
              reply(req.id, toolText(
                'База пуста. Положите документы в ' + layout.docsDir
                + ' и выполните индексацию (ragana --index).', true,
              ));
              return;
            }

            const { Searcher, sourceOf } = await import('./search.ts');
            const searcher = new Searcher(store, await getEmbedder());
            searcher.setDocsDir(layout.docsDir);

            const res = await searcher.search(query, {
              k: Math.min(20, Math.max(1, Number(args.limit ?? 5))),
              mode: (typeof args.mode === 'string' ? args.mode : 'hybrid') as never,
            });

            await writeSearchLog(
              layout.searchesDir, query,
              res.citations.map((c) => ({ path: sourceOf(c.chunk), text: c.chunk.text })),
            );

            if (res.citations.length === 0) {
              reply(req.id, toolText('Ничего не найдено по запросу: ' + query));
              return;
            }

            reply(req.id, toolText(JSON.stringify({
              query: res.query,
              citations: res.citations.map((c) => ({
                path: c.chunk.path,
                location: c.chunk.label
                  ?? (c.chunk.page !== undefined ? `с. ${c.chunk.page}` : null),
                page: c.chunk.page ?? null,
                startSec: c.chunk.startSec ?? null,
                endSec: c.chunk.endSec ?? null,
                score: Number(c.score.toFixed(5)),
                via: c.via,
                text: c.chunk.text,
              })),
            }, null, 2)));
          } finally {
            store.close();
          }
          return;
        }

        fail(req.id, -32601, `неизвестный инструмент: ${name}`);
        return;
      }

      default:
        fail(req.id, -32601, `неизвестный метод: ${req.method}`);
    }
  };

  // Построчное чтение stdin: MCP передаёт по одному JSON-объекту на
  // строку. Частичные строки накапливаются в буфере — пакет может
  // прийти разрезанным по границе чтения.
  let buffer = '';
  for await (const chunk of process.stdin) {
    buffer += new TextDecoder().decode(chunk as Uint8Array);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let req: Request;
      try {
        req = JSON.parse(trimmed);
      } catch {
        // Ответить на неразобранный запрос нечем: id неизвестен
        continue;
      }
      try {
        await handle(req);
      } catch (e) {
        fail(req.id, -32603, (e as Error).message);
      }
    }
  }
  return 0;
}
