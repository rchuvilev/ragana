#!/usr/bin/env bun
// Сборка веб-страницы: bun scripts/build-webpage.ts -> dist-webpage/
//
// Та же кодовая база, что у бинаря: core/*.mjs работают и в Node, и в
// браузере без изменений — это проверено исполнением в реальном WebView.
//
// Отличие от десктопа: модель НЕ вшивается. 113 МБ в HTML-странице
// означали бы 113 МБ трафика при каждом открытии; в браузере она
// кэшируется самим Transformers.js после первой загрузки с CDN.

import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, C, say, mb, version, freshDist, copy } from './common.ts';

const ver = await version();
say('сборка веб-страницы -> dist-webpage');
const dist = await freshDist('dist-webpage');

// --- ядро ---
await mkdir(join(dist, 'core'), { recursive: true });
const coreFiles = (await readdir(join(ROOT, 'core'))).filter((f) => f.endsWith('.mjs'));
for (const f of coreFiles) {
  await copy(join(ROOT, 'core', f), join(dist, 'core', f));
}
console.log(`  core/: ${coreFiles.length} модулей`);

// --- веб-слой ---
for (const f of ['index.html', 'style.css', 'app.js', 'pdf-web.js']) {
  await copy(join(ROOT, 'web', f), join(dist, f));
}

// 🔴 ПУТИ ИМПОРТОВ ОБЯЗАТЕЛЬНО ПЕРЕПИСАТЬ. В репозитории web/app.js
// импортирует '../core/...', потому что ядро лежит на уровень выше. В
// сборке раскладка ПЛОСКАЯ: core/ рядом с app.js. Без правки путь
// '../core/' уводит ЗА ПРЕДЕЛЫ сайта, модуль не грузится
// ('Failed to fetch dynamically imported module'), и страница
// отрисовывается, но ни одна кнопка не работает — отказ молчаливый,
// в консоли при клике НИЧЕГО не появляется.
//
// APK и Chrome-расширение делали это с самого начала
// (tools/build-apk.sh, tools/build-extension.sh), а веб-сборка — нет.
const appPath = join(dist, 'app.js');
const appSrc = await Bun.file(appPath).text();
const rewritten = (appSrc.match(/from '\.\.\//g) ?? []).length;
// Переписываем ЛЮБОЙ путь на уровень выше, не только core/: завтра
// появится './web/…' или другой каталог, и правило должно работать.
const fixed = appSrc.replaceAll("from '../", "from './");
await Bun.write(appPath, fixed);

// Контроль ПОСЛЕ записи, на итоговом содержимом: проверять исходник
// бессмысленно — там пути как раз и должны быть относительными.
const check = await Bun.file(appPath).text();
if (check.includes("from '../")) {
  throw new Error('в app.js остались пути вида ../ — модуль не загрузится');
}
console.log(`  веб-слой: 4 файла, путей переписано: ${rewritten}`);

// --- манифест PWA ---
// Нужен, чтобы страницу можно было «установить» на телефон и открывать
// как приложение, без адресной строки.
await Bun.write(join(dist, 'manifest.webmanifest'), JSON.stringify({
  // id и scope ОТНОСИТЕЛЬНЫЕ: страница живёт в подпапке
  // (rchuvilev.github.io/ragana/), и абсолютный '/ragana/' сломался бы
  // при открытии с другого хоста или локально.
  id: './',
  name: 'ragana — поиск по документам',
  short_name: 'ragana',
  description: 'Локальный RAG по вашим файлам. Ничего не покидает устройство.',
  start_url: './index.html',
  scope: './',
  display: 'standalone',
  background_color: '#111318',
  theme_color: '#111318',
  lang: 'ru',
  icons: [
    { src: './icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: './icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
}, null, 2));

// Иконки под PWA
for (const [size, name] of [[192, 'icon-192.png'], [512, 'icon-512.png']] as const) {
  const proc = Bun.spawn([
    'magick', join(ROOT, 'assets', 'icon-source.jpg'),
    '-resize', `${size}x${size}`, '-strip', join(dist, name),
  ], { stdout: 'ignore', stderr: 'pipe' });
  if ((await proc.exited) !== 0) {
    console.log(C.y(`  иконка ${name} не создана (нет magick?)`));
  }
}

// --- service worker ---
// Кэширует только собственные файлы. Модель (113 МБ) намеренно НЕ
// кэшируется здесь: Transformers.js держит её в своём Cache Storage, и
// дублирование съело бы вдвое больше места.
await Bun.write(join(dist, 'sw.js'), `// ragana ${ver}
const CACHE = 'ragana-${ver}';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './pdf-web.js',
  './manifest.webmanifest',
${coreFiles.map((f) => `  './core/${f}',`).join('\n')}
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // Старые версии кэша удаляются, иначе обновление страницы не доезжает
  // до пользователя: он продолжает видеть прежнюю сборку.
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
    )).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Чужие домены (CDN модели) не перехватываем: там свои правила кэша
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit ?? fetch(e.request)),
  );
});
`);

// Подключаем манифест и воркер к странице
const htmlPath = join(dist, 'index.html');
let html = await Bun.file(htmlPath).text();
html = html.replace(
  '<link rel="stylesheet" href="style.css">',
  '<link rel="stylesheet" href="style.css">\n'
  + '<link rel="manifest" href="manifest.webmanifest">\n'
  + '<link rel="icon" href="icon-192.png">',
);
html = html.replace(
  '</body>',
  '<script>\n'
  + "if ('serviceWorker' in navigator) {\n"
  + "  addEventListener('load', () => navigator.serviceWorker.register('sw.js'));\n"
  + '}\n'
  + '</script>\n</body>',
);
await Bun.write(htmlPath, html);

// --- проверка: внешних ссылок быть не должно, кроме CDN модели ---
const appJs = await Bun.file(join(dist, 'app.js')).text();
const externals = [...appJs.matchAll(/https?:\/\/[^'"`\s)]+/g)].map((m) => m[0]);
const unexpected = externals.filter((u) => !u.includes('cdn.jsdelivr.net'));
if (unexpected.length > 0) {
  console.log(C.y(`  внешние ссылки: ${unexpected.slice(0, 3).join(', ')}`));
}

let total = 0;
for (const f of await readdir(dist, { recursive: true, withFileTypes: true } as any) as any) {
  if (f.isFile?.()) total += Bun.file(join(f.parentPath ?? dist, f.name)).size;
}

await Bun.write(join(dist, 'README.md'), [
  '# ragana — веб-версия',
  '',
  'Статические файлы: положите на любой хостинг или откройте локально.',
  '',
  '```sh',
  'python3 -m http.server 8080 --directory dist-webpage',
  '# http://127.0.0.1:8080/index.html',
  '```',
  '',
  '## Что отличается от бинаря',
  '',
  '| | бинарь | веб |',
  '|---|---|---|',
  '| модель | вшита (520 МБ) | тянется с CDN, кэшируется |',
  '| документы | папка на диске | выбор папки в браузере |',
  '| OCR картинок | tesseract (66 языков) | нет |',
  '| аудио и видео | whisper | нет |',
  '| PDF | текстовый слой + OCR сканов | только текстовый слой |',
  '',
  'Веб-версия работает с текстом, Markdown и PDF с текстовым слоем.',
  'Для сканов, картинок и медиа нужен десктопный бинарь: распознавание',
  'опирается на системные утилиты, которых в браузере нет.',
  '',
  '## Требования браузера',
  '',
  '- IndexedDB (хранилище индекса)',
  '- `crypto.subtle` (хэши файлов) — только на `https://` или `localhost`',
  '- `DecompressionStream` (разбор PDF)',
  '- File System Access API — для выбора папки; без него доступен',
  '  запасной путь через выбор отдельных файлов',
  '',
].join('\n'));

console.log(C.g(`\nготово: dist-webpage/ (${mb(total)})`));
