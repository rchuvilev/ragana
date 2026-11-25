#!/usr/bin/env bun
// ragana — точка входа. Только разбор аргументов и диспетчеризация.
//
// Сами команды живут в src/commands.ts: раньше они были одним switch на
// 191 строку внутри main(), где невозможно увидеть отдельную команду, не
// прокручивая соседние.
//
// Флаги по требованиям:
//   --index           переиндексация папки
//   --search <промпт> RAG-поиск
//   --open            открыть папку документов
//   --gui             TUI
// Если флагов несколько — действует ТОЛЬКО ПЕРВЫЙ.
// Без флагов (или запуск кликом) = --gui.

import { C } from './colors.ts';
import { ensureWorkspace } from './workspace.ts';
import {
  cmdOpen, cmdStatus, cmdIndex, cmdSearch, cmdReset, EXIT,
  type CommandContext,
} from './commands.ts';
import type { Embedder } from './types.ts';

/** Действия в порядке приоритета: первый встреченный флаг побеждает. */
const ACTIONS = [
  'index', 'search', 'open', 'gui', 'status', 'reset', 'mcp', 'help',
] as const;
export type Action = (typeof ACTIONS)[number];

/** Флаги-переключатели: не принимают значение. */
const BOOLEAN = new Set([
  'json', 'quiet', 'no-expand', 'help', 'version', 'media', 'force', 'cooc',
]);

/** Флаги со значением. */
const VALUED = new Set([
  'k', 'mode', 'asr', 'lang', 'home', 'pool', 'ocr', 'min-score',
]);

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
 * модификаторы (--json, --k) остаются в силе, иначе
 * `--search "..." --json` не смог бы отдать машиночитаемый вывод, а это
 * основной сценарий в пайплайне.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const unknown: string[] = [];
  const rest: string[] = [];
  let action: Action | null = null;
  let prompt = '';

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const key = a.slice(2);

    if ((ACTIONS as readonly string[]).includes(key)) {
      // Первое действие фиксируется, последующие игнорируются
      if (action === null) {
        action = key as Action;
        if (key === 'search') {
          // Промпт — всё до следующего флага: работает и
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
      flags[key] = (i + 1 < argv.length && !argv[i + 1]!.startsWith('--'))
        ? argv[++i]!
        : true;
    } else {
      // 🔴 Опечатка в флаге НЕ должна молча запускать другой режим.
      // `--serch "вопрос"` уходил в gui и ждал ввода с клавиатуры, то
      // есть выглядел как зависание — и подвесил сборку на позитивном
      // контроле, а затем и всю песочницу.
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
  ${C.c('ragana --reset')}              сбросить индекс (документы цел��)
  ${C.c('ragana --mcp')}                сервер MCP поверх stdio

${C.dim('Без флагов запускается --gui.')}
${C.dim('Если флагов действия несколько — работает только первый.')}

${C.b('Модификаторы')}
  --json             машиночитаемый вывод (для пайплайна)
  --k <N>            сколько цитат (по умолчанию 5)
  --mode <режим>     hybrid | vector | lexical
  --min-score <N>    порог сходства, по умолчанию 0.811
                     ${C.dim('(ниже — считается, что не нашли)')}
  --no-expand        не расширять запрос синонимами
  --cooc             расширять словарём из корпуса
                     ${C.dim('(на малых корпусах ухудшает — см. docs)')}
  --media            расшифровывать аудио и видео ${C.dim('(долго!)')}
  --asr <модель>     tiny | base | small
  --lang <языки>     языки OCR, например rus+eng+deu
  --ocr <движок>     tesseract | florence | auto
  --home <путь>      другой каталог рабочего места

${C.b('Коды возврата')}
  0 успех · 2 неверный вызов · 3 индекс пуст · 4 ничего не найдено

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
    return EXIT.badUsage;
  }

  if (action === 'help' || flags.help) {
    console.log(helpText());
    return EXIT.ok;
  }

  const base = typeof flags.home === 'string' ? flags.home : undefined;
  const { layout, created } = await ensureWorkspace(base);

  if (created) {
    console.log(C.g('создано рабочее место:'));
    console.log(`  ${layout.root}`);
    console.log(C.dim(`  документы кладите в ${layout.docsDir}`));
  }

  const ctx: CommandContext = { layout, flags, makeEmbedder };

  switch (action) {
    case 'open': return cmdOpen(ctx);
    case 'status': return cmdStatus(ctx);
    case 'index': return cmdIndex(ctx);
    case 'search': return cmdSearch(ctx, prompt);
    case 'reset': return cmdReset(ctx);

    case 'mcp': {
      // Типизированный контракт вместо разбора текстового вывода: через
      // него ragana подключается к Claude Code, Codex и любому другому
      // клиенту MCP.
      const { runMcp } = await import('./mcp.ts');
      return runMcp(makeEmbedder);
    }

    case 'gui': {
      const { runTui } = await import('./tui.ts');
      return runTui(layout);
    }

    default:
      console.log(helpText());
      return EXIT.ok;
  }
}

if (import.meta.main) {
  main()
    .then((code) => { process.exit(code); })
    .catch((e: unknown) => {
      console.error(C.r('ошибка: ') + ((e as Error)?.message ?? String(e)));
      process.exit(EXIT.error);
    });
}
