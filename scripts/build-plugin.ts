#!/usr/bin/env bun
// Сборка плагина Claude Code: bun scripts/build-plugin.ts -> dist-plugin/
//
// Формат повторяет claude-plugin-grimoire: .claude-plugin/plugin.json,
// бинари, запускатель. Сверх того кладутся скилл и MCP-сервер — через
// них ragana становится инструментом, который модель вызывает сама.
//
// Зачем MCP, когда есть CLI: модель не должна разбирать текстовый вывод
// и угадывать формат. MCP даёт типизированный контракт — запрос на входе,
// структурированные цитаты с координатами на выходе.

import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TARGETS, ROOT, C, say, mb, version, ensureVendor, freshDist, compile, copy,
} from './common.ts';

const check = process.argv.includes('--check');
const all = process.argv.includes('--all');
const ver = await version();

say(`сборка плагина -> dist-plugin${check ? ' (только проверка)' : ''}`);

if (!check) await ensureVendor();
const dist = await freshDist('dist-plugin');

// --- бинари ---
const BINARIES: Record<string, string> = {
  'mac:intel': 'ragana-mac-intel',
  'mac:silicon': 'ragana-mac',
  win: 'ragana-win.exe',
  linux: 'ragana-linux',
};

function currentTargetId(): string {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'mac:silicon' : 'mac:intel';
  }
  return 'linux';
}

let total = 0;
if (!check) {
  const ids = all ? Object.keys(TARGETS) : [currentTargetId()];
  for (const id of ids) {
    const name = BINARIES[id]!;
    console.log(C.dim(`  ${id} -> ${name}`));
    const built = await compile({ ...TARGETS[id]!, binary: name }, dist);
    if (!name.endsWith('.exe')) await chmod(built.path, 0o755);
    total += built.bytes;
  }
}

// --- манифест плагина ---
await mkdir(join(dist, '.claude-plugin'), { recursive: true });
await Bun.write(join(dist, '.claude-plugin', 'plugin.json'), JSON.stringify({
  name: 'ragana',
  display_name: 'ragana',
  description: 'Локальный RAG по вашим документам: поиск с цитатами, указанием страницы и таймкода. Всё работает офлайн.',
  version: ver,
  license: 'MIT',
  author: { name: 'HexStack', email: 'hexstack.app+support@gmail.com' },
  homepage: 'https://github.com/hexstack-apps/ragana',
  repository: 'https://github.com/hexstack-apps/ragana',
  platforms: ['darwin', 'linux', 'win32'],
  arch: ['x64', 'arm64'],
  commands: './commands/',
  skills: './skills/',
  mcpServers: './.mcp.json',
}, null, 2));

// --- MCP-сервер ---
// Регистрируется через сам бинарь: отдельный процесс-сервер не нужен,
// режим --mcp поднимает stdio-транспорт внутри того же исполняемого файла.
await Bun.write(join(dist, '.mcp.json'), JSON.stringify({
  mcpServers: {
    ragana: {
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/launcher.js', '--mcp'],
      env: {},
    },
  },
}, null, 2));

// --- запускатель ---
await copy(join(ROOT, 'templates', 'launcher-plugin.js'), join(dist, 'launcher.js'));
await chmod(join(dist, 'launcher.js'), 0o755);

// --- команды ---
await mkdir(join(dist, 'commands'), { recursive: true });

await Bun.write(join(dist, 'commands', 'index.md'), [
  '---',
  'description: Проиндексировать папку документов ragana',
  '---',
  '',
  'Запусти индексацию локальной базы документов:',
  '',
  '```sh',
  'node "${CLAUDE_PLUGIN_ROOT}/launcher.js" --index',
  '```',
  '',
  'Индексируются только новые и изменённые файлы — реестр хранит хэши.',
  'Для аудио и видео добавь `--media` (расшифровка идёт долго: примерно',
  'вчетверо дольше самой записи).',
  '',
].join('\n'));

await Bun.write(join(dist, 'commands', 'search.md'), [
  '---',
  'description: Найти ответ в локальных документах ragana',
  'argument-hint: <вопрос>',
  '---',
  '',
  'Найди в локальной базе документов ответ на вопрос: $ARGUMENTS',
  '',
  '```sh',
  'node "${CLAUDE_PLUGIN_ROOT}/launcher.js" --search "$ARGUMENTS" --json',
  '```',
  '',
  'В ответе: дословные цитаты, путь к файлу и координата (страница либо',
  'таймкод). Опирайся ТОЛЬКО на эти цитаты и указывай источник каждой.',
  'Если цитат нет — так и скажи, не додумывай.',
  '',
].join('\n'));

await Bun.write(join(dist, 'commands', 'status.md'), [
  '---',
  'description: Состояние базы документов ragana',
  '---',
  '',
  '```sh',
  'node "${CLAUDE_PLUGIN_ROOT}/launcher.js" --status --json',
  '```',
  '',
].join('\n'));

// --- скилл ---
// Скилл объясняет модели, КОГДА и КАК применять инструмент: без него
// модель видит команды, но не понимает, что искать в локальной базе
// надо раньше, чем отвечать по памяти.
await mkdir(join(dist, 'skills', 'ragana-search'), { recursive: true });
await Bun.write(join(dist, 'skills', 'ragana-search', 'SKILL.md'), [
  '---',
  'name: ragana-search',
  'description: >-',
  '  Поиск по личным и рабочим документам пользователя (PDF, сканы,',
  '  изображения, текст, аудио, видео) с дословными цитатами и указанием',
  '  страницы или таймкода. Используй ВСЕГДА, когда вопрос касается',
  '  содержимого файлов пользователя: договоров, регламентов, выписок,',
  '  заметок, записей встреч. Работает офлайн, данные не покидают машину.',
  '---',
  '',
  '# Поиск по документам (ragana)',
  '',
  '## Когда применять',
  '',
  'Вопрос касается содержимого файлов пользователя — ищи в базе, а не',
  'отвечай по памяти. Признаки: «в договоре», «по регламенту», «в моих',
  'заметках», «что там было про», упоминание конкретного документа.',
  '',
  '## Как',
  '',
  '```sh',
  'node "${CLAUDE_PLUGIN_ROOT}/launcher.js" --search "вопрос" --json',
  '```',
  '',
  'Ответ:',
  '',
  '```json',
  '{',
  '  "prompt": "исходный вопрос",',
  '  "query": "расширенный запрос",',
  '  "citations": [',
  '    { "path": "полис.pdf", "page": 3, "label": "с. 3",',
  '      "score": 0.0328, "via": "hybrid", "text": "дословная цитата" }',
  '  ]',
  '}',
  '```',
  '',
  '## Правила работы с результатом',
  '',
  '1. **Опирайся только на цитаты.** Они дословны — это вырезка из файла,',
  '   а не пересказ. Не дополняй их общими знаниями молча.',
  '2. **Всегда указывай источник**: файл и координату (`с. 3`,',
  '   `01:05–01:30`). Пользователь должен иметь возможность проверить.',
  '3. **Нет цитат — так и скажи.** Коды возврата: `3` — индекс пуст',
  '   (нужен `--index`), `4` — ничего не найдено.',
  '4. **`[описание изображения]`** в начале цитаты означает, что это',
  '   пересказ картинки нейросетью, а не текст с неё. Отмечай это.',
  '',
  '## Если индекс пуст',
  '',
  'Скажи пользователю положить файлы в папку `ragana/knowledgebase`',
  '(открывается командой `--open`) и запустить `--index`.',
  '',
  '## Чего инструмент не делает',
  '',
  'Он не отвечает на вопрос — он находит выдержки. Ответ формулируешь ты,',
  'но строго по найденному.',
  '',
].join('\n'));

// --- УНИФИКАЦИЯ ПОД РАЗНЫЕ АГЕНТЫ ---
//
// Формат плагинов фрагментирован: Claude Code ждёт .claude-plugin/ и
// commands/*.md, Codex и Cursor читают .mcp.json либо свой конфиг,
// Continue — config.json. Общий знаменатель у всех ОДИН: MCP-сервер
// поверх stdio. Поэтому ядро плагина — .mcp.json, а остальное
// надстройки, каждая из которых ссылается на тот же launcher.js.
//
// Так один каталог ставится куда угодно: где понимают плагины Claude —
// как плагин, где только MCP — как сервер.

// Codex CLI / Cursor / Windsurf: конфигурация MCP в своём формате
await Bun.write(join(dist, 'mcp-config-examples.json'), JSON.stringify({
  _comment: 'Примеры подключения для агентов, не понимающих формат плагинов Claude Code. Подставьте абсолютный путь вместо <ПУТЬ>.',
  'claude-code': {
    _how: 'claude mcp add ragana -- node <ПУТЬ>/launcher.js --mcp',
    mcpServers: { ragana: { command: 'node', args: ['<ПУТЬ>/launcher.js', '--mcp'] } },
  },
  'codex-cli': {
    _how: '~/.codex/config.toml, секция [mcp_servers.ragana]',
    _toml: 'command = "node"\nargs = ["<ПУТЬ>/launcher.js", "--mcp"]',
  },
  cursor: {
    _how: '.cursor/mcp.json в корне проекта',
    mcpServers: { ragana: { command: 'node', args: ['<ПУТЬ>/launcher.js', '--mcp'] } },
  },
  'vscode-copilot': {
    _how: '.vscode/mcp.json',
    servers: { ragana: { type: 'stdio', command: 'node', args: ['<ПУТЬ>/launcher.js', '--mcp'] } },
  },
  'zed-continue-other': {
    _how: 'Любой клиент MCP: команда node, аргумент --mcp, транспорт stdio',
    command: 'node',
    args: ['<ПУТЬ>/launcher.js', '--mcp'],
    transport: 'stdio',
  },
}, null, 2));

// Установщик копируется из templates/: писать shell-скрипт строкой
// внутри TypeScript — верный способ получить ошибку экранирования,
// которая проявится только при запуске у пользователя.
await copy(join(ROOT, 'templates', 'install.sh'), join(dist, 'install.sh'));
await chmod(join(dist, 'install.sh'), 0o755);

// AGENTS.md — соглашение, которое читают Codex и ряд других агентов.
// Дублирует суть скилла: инструмент бесполезен, если агент не знает,
// когда его применять.
await Bun.write(join(dist, 'AGENTS.md'), [
  '# ragana — поиск по документам пользователя',
  '',
  'Локальная база документов с дословными цитатами. Работает офлайн.',
  '',
  '## Когда обращаться',
  '',
  'Вопрос касается содержимого файлов пользователя — ищи в базе, а не',
  'отвечай по памяти. Признаки: «в договоре», «по регламенту», «в моих',
  'заметках», «что там было про», упоминание конкретного документа.',
  '',
  '## Как',
  '',
  'Через MCP: инструмент `search_documents`, аргумент `query`.',
  'Либо напрямую: `node launcher.js --search "вопрос" --json`',
  '',
  '## Правила',
  '',
  '1. Цитаты дословны — это вырезка из файла. Не дополняй их молча.',
  '2. Всегда указывай файл и координату (`с. 3`, `01:05–01:30`).',
  '3. Нет цитат — скажи прямо. Код 3 = индекс пуст, 4 = не найдено.',
  '4. `[описание изображения]` — пересказ картинки нейросетью, а не',
  '   текст с неё. Отмечай это.',
  '',
].join('\n'));

// --- документация ---
await Bun.write(join(dist, 'README.md'), [
  '# ragana — плагин Claude Code',
  '',
  'Локальный поиск по документам с цитатами. Ничего не покидает машину.',
  '',
  '## Установка',
  '',
  '```sh',
  'claude plugin marketplace add hexstack-apps/ragana',
  'claude plugin install ragana',
  '```',
  '',
  '## Команды',
  '',
  '| команда | действие |',
  '|---|---|',
  '| `/ragana:index` | проиндексировать изменения |',
  '| `/ragana:search <вопрос>` | найти с цитатами |',
  '| `/ragana:status` | состояние базы |',
  '',
  'Плюс скилл `ragana-search` — Claude сам обращается к базе, когда',
  'вопрос касается ваших файлов.',
  '',
  '## MCP',
  '',
  'Регистрируется сервер `ragana` с типизированным контрактом: на вход',
  'вопрос, на выход цитаты с координатами. Это надёжнее разбора',
  'текстового вывода.',
  '',
].join('\n'));

// --- проверка состава ---
const required = [
  // ядро: понимают все клиенты MCP
  '.mcp.json', 'launcher.js', 'install.sh', 'mcp-config-examples.json',
  // надстройка для Claude Code
  '.claude-plugin/plugin.json',
  'commands/index.md', 'commands/search.md', 'commands/status.md',
  'skills/ragana-search/SKILL.md',
  // соглашение для Codex и прочих
  'AGENTS.md', 'README.md',
];
let missing = 0;
for (const f of required) {
  if (!(await Bun.file(join(dist, f)).exists())) {
    console.log(C.r(`  нет файла: ${f}`));
    missing++;
  }
}

if (missing > 0) {
  console.log(C.r(`\nсостав неполон: не хватает ${missing} файлов`));
  process.exit(1);
}

console.log(C.g(`\nготово: dist-plugin/ (${required.length} файлов${total ? `, бинари ${mb(total)}` : ''})`));
if (check) console.log(C.dim('  бинари не собирались (--check)'));
else if (!all) console.log(C.dim('  для всех платформ: --all'));
