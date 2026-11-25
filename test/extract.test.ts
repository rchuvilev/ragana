import { test, expect } from 'bun:test';
import {
  kindOf, needsTranscript, transcriptPath, stamp,
  parseAnchors, anchorAt, extractToMarkdown,
} from '../src/extract.ts';

const REAL_PDF = '/var/minis/shared/Flights_AGP-RIX_25-26_Oct_2026.pdf';

test('классификация по расширению', () => {
  expect(kindOf('a.txt')).toBe('text');
  expect(kindOf('a.MD')).toBe('text');
  expect(kindOf('doc.pdf')).toBe('pdf');
  expect(kindOf('скан.JPEG')).toBe('image');
  expect(kindOf('запись.mp3')).toBe('audio');
  expect(kindOf('лекция.mkv')).toBe('video');
  expect(kindOf('archive.zip')).toBe('unsupported');
  expect(kindOf('noext')).toBe('unsupported');
});

test('расшифровка нужна только не-текстовым', () => {
  expect(needsTranscript('a.txt')).toBe(false);
  expect(needsTranscript('a.pdf')).toBe(true);
  expect(needsTranscript('a.png')).toBe(true);
  expect(needsTranscript('a.mp4')).toBe(true);
  expect(needsTranscript('a.zip')).toBe(false);
});

test('путь расшифровки — рядом с оригиналом', () => {
  expect(transcriptPath('docs/отчёт.pdf')).toBe('docs/отчёт.pdf.md');
  // расширение сохраняется, иначе report.pdf и report.docx столкнулись бы
  expect(transcriptPath('a/report.docx')).toBe('a/report.docx.md');
});

test('таймкоды форматируются', () => {
  expect(stamp(0)).toBe('00:00.000');
  expect(stamp(65.5)).toBe('01:05.500');
  expect(stamp(3599.999)).toBe('59:59.999');
});

test('парсинг координат-страниц', () => {
  const md = '# файл\n\n## [с. 1]\n\nПервая\n\n## [с. 7]\n\nСедьмая\n';
  const a = parseAnchors(md);
  expect(a.length).toBe(2);
  expect(a[0]!.page).toBe(1);
  expect(a[1]!.page).toBe(7);
  expect(a[1]!.label).toBe('с. 7');
});

test('парсинг координат-таймкодов', () => {
  const md = '## [00:00.000–00:30.000]\n\nначало\n\n## [01:05.500–01:30.000]\n\nдалее\n';
  const a = parseAnchors(md);
  expect(a.length).toBe(2);
  expect(a[0]!.startSec).toBe(0);
  expect(a[0]!.endSec).toBe(30);
  expect(a[1]!.startSec).toBeCloseTo(65.5, 3);
  expect(a[1]!.label).toBe('01:05–01:30');
});

test('якорь по смещению', () => {
  const md = '## [с. 1]\n\nAAA\n\n## [с. 2]\n\nBBB\n';
  const a = parseAnchors(md);
  const posB = md.indexOf('BBB');
  expect(anchorAt(a, posB)!.page).toBe(2);
  const posA = md.indexOf('AAA');
  expect(anchorAt(a, posA)!.page).toBe(1);
});

test('🔴 смещение в шапке относится к ПЕРВОЙ единице, а не к «нигде»', () => {
  // Раньше возвращался undefined, то есть цитата из шапки оставалась без
  // координаты. Шапка описывает файл целиком — это первая страница.
  const md = '<!-- шапка -->\n# файл\n\n- метод: OCR\n\n## [с. 1]\n\nтекст\n';
  const a = parseAnchors(md);
  expect(anchorAt(a, 5)!.page).toBe(1);
});

test('пустой MD не ломает разбор', () => {
  expect(parseAnchors('')).toEqual([]);
  expect(anchorAt([], 0)).toBeUndefined();
});

test('🟢 РЕАЛЬНЫЙ PDF: страницы и координаты', async () => {
  if (!(await Bun.file(REAL_PDF).exists())) return;
  const r = await extractToMarkdown(REAL_PDF);
  expect(r.units).toBe(2);
  expect(r.method).toContain('pdftotext');
  expect(r.warnings).toEqual([]);

  const a = parseAnchors(r.markdown);
  expect(a.map((x) => x.page)).toEqual([1, 2]);

  // текст второй страницы обязан находиться ПОСЛЕ её якоря
  const p2 = a[1]!;
  const tail = r.markdown.slice(p2.offset);
  expect(tail.length).toBeGreaterThan(100);
  // не-ASCII сохранены (ToUnicode отрабатывает)
  expect(r.markdown).toContain('Málaga');
});

test('🟢 РЕАЛЬНОЕ изображение: OCR кириллицы', async () => {
  const img = '/tmp/ocr-test.png';
  if (!(await Bun.file(img).exists())) return;
  const r = await extractToMarkdown(img, { ocrLanguages: 'rus' });
  expect(r.units).toBe(1);
  expect(r.markdown).toContain('Франшиза');
  expect(r.markdown).toContain('300');
  expect(parseAnchors(r.markdown)[0]!.page).toBe(1);
});

test('🔴 медиа без согласия: ЧЕСТНЫЙ отказ с оценкой времени', async () => {
  const wav = '/tmp/speech.wav';
  if (!(await Bun.file(wav).exists())) return;
  const r = await extractToMarkdown(wav, { media: 'skip' });
  expect(r.units).toBe(0);
  expect(r.markdown).toBe('');
  // Молчаливая индексация пустого документа была бы хуже отказа
  expect(r.warnings.length).toBe(1);
  expect(r.warnings[0]).toContain('--media');
  expect(r.warnings[0]).toMatch(/\d+ с медиа/);
});

test('неподдерживаемый формат сообщает о себе', async () => {
  const tmp = '/tmp/ragana-test.zip';
  await Bun.write(tmp, 'PK\x03\x04fake');
  const r = await extractToMarkdown(tmp);
  expect(r.units).toBe(0);
  expect(r.warnings[0]).toContain('не поддерживается');
});

test('🔴 таблицы форматов ядра и платформы СОГЛАСОВАНЫ', async () => {
  // Страж против расхождения: аудио и видео однажды были ТОЛЬКО в
  // src/extract.ts, и веб-версия классифицировала mp3 как 'unknown' —
  // вместо внятного «расшифровка доступна в десктопной версии»
  // пользователь видел «формат не поддерживается».
  //
  // Тест живёт в Bun-наборе, а не в node:test: последний не умеет
  // импортировать .ts ('Unknown file extension .ts').
  const { detect, formatInfo } = await import('../core/formats.mjs');
  const samples = [
    'a.txt', 'a.md', 'a.csv', 'a.html',
    'a.pdf',
    'a.png', 'a.jpg', 'a.webp', 'a.heic',
    'a.mp3', 'a.wav', 'a.flac',
    'a.mp4', 'a.mkv', 'a.webm',
  ];
  const mismatched: string[] = [];
  for (const name of samples) {
    const platform = kindOf(name);
    const core = formatInfo(detect(name, null)).kind;
    if (platform !== core) {
      mismatched.push(`${name}: платформа=${platform} ядро=${core}`);
    }
  }
  expect(mismatched).toEqual([]);
});
