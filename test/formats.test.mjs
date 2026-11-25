import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sniff, extOf, detect, looksLikeText, formatInfo,
  isSupported, parserVersionFor, needsReparse, KIND,
} from '../core/formats.mjs';

/** @param {number[]} b */
const bytes = (...b) => new Uint8Array(b);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a);
/** @param {string} s */
const utf8 = (s) => new TextEncoder().encode(s);

test('sniff опознаёт основные сигнатуры', () => {
  assert.equal(sniff(PDF), 'pdf');
  assert.equal(sniff(JPEG), 'jpeg');
  assert.equal(sniff(PNG), 'png');
  assert.equal(sniff(utf8('просто текст')), null, 'у текста нет сигнатуры');
});

test('sniff с ненулевым смещением (webp/heic)', () => {
  const webp = new Uint8Array(16);
  webp.set(utf8('RIFF'), 0);
  webp.set(utf8('WEBP'), 8);
  assert.equal(sniff(webp), 'webp');
  const heic = new Uint8Array(16);
  heic.set(utf8('ftyp'), 4);
  assert.equal(sniff(heic), 'heic');
});

test('sniff не читает за границу короткого буфера', () => {
  assert.doesNotThrow(() => sniff(bytes(0x25)));
  assert.equal(sniff(bytes(0x25)), null);
  assert.equal(sniff(new Uint8Array(0)), null);
});

test('extOf', () => {
  assert.equal(extOf('a/b/doc.PDF'), 'pdf');
  assert.equal(extOf('скан.jpeg'), 'jpeg');
  assert.equal(extOf('noext'), '');
  assert.equal(extOf('.hidden'), '', 'точка в начале — не расширение');
  assert.equal(extOf('a.tar.gz'), 'gz');
});

test('содержимое ПЕРЕВЕШИВАЕТ расширение', () => {
  // главный сценарий: PDF, присланный как .txt
  assert.equal(detect('письмо.txt', PDF), 'pdf');
  assert.equal(detect('скан.pdf', JPEG), 'jpeg');
});

test('файл без расширения опознаётся по содержимому', () => {
  // Android SAF часто отдаёт `document(1)` без расширения
  assert.equal(detect('document(1)', PDF), 'pdf');
  assert.equal(detect('document(1)', utf8('привет мир')), 'text');
});

test('расширение используется, когда байтов нет', () => {
  assert.equal(detect('a.pdf', null), 'pdf');
  assert.equal(detect('a.md', null), 'text');
  assert.equal(detect('a.xyz', null), 'unknown');
});

test('looksLikeText: кириллица в UTF-8 — текст, бинарь — нет', () => {
  assert.equal(looksLikeText(utf8('Привет, мир! Это текст.')), true);
  assert.equal(looksLikeText(bytes(0, 1, 2, 3)), false, 'нулевой байт');
  assert.equal(looksLikeText(new Uint8Array(0)), true, 'пустой файл');
  const noisy = new Uint8Array(100).fill(7); // управляющие символы
  assert.equal(looksLikeText(noisy), false);
});

test('классификация по видам', () => {
  assert.equal(formatInfo('text').kind, KIND.text);
  assert.equal(formatInfo('pdf').kind, KIND.pdf);
  assert.equal(formatInfo('jpeg').kind, KIND.image);
  assert.equal(formatInfo('jpeg').ocr, true, 'картинка требует OCR');
  assert.equal(formatInfo('pdf').ocr, 'fallback', 'PDF — OCR только при отсутствии текста');
  assert.equal(formatInfo('чего-то').kind, KIND.unknown, 'неизвестный формат безопасен');
});

test('isSupported', () => {
  assert.equal(isSupported('text'), true);
  assert.equal(isSupported('pdf'), true);
  assert.equal(isSupported('zip'), false);
  assert.equal(isSupported('unknown'), false);
});

test('needsReparse: нет прошлой записи -> разбирать', () => {
  assert.equal(needsReparse({ hash: 'H', format: 'pdf' }, null), true);
});

test('needsReparse: другой хэш -> разбирать', () => {
  assert.equal(
    needsReparse({ hash: 'H2', format: 'pdf' },
                 { hash: 'H1', parserVersion: 1 }), true);
});

test('🔴 needsReparse: НОВЫЙ ПАРСЕР при том же хэше -> разбирать', () => {
  // Это и есть причина существования parserVersion: содержимое файла
  // не менялось, поэтому хэш прежний, и diff сказал бы «работы нет».
  // Индекс остался бы навсегда построен старым парсером.
  /** @type {{hash: string, parserVersion: number}} */
  const prev = { hash: 'H', parserVersion: 0 };
  assert.equal(parserVersionFor('pdf'), 1);
  assert.equal(needsReparse({ hash: 'H', format: 'pdf' }, prev), true);
});

test('needsReparse: всё совпало -> НЕ разбирать', () => {
  const prev = { hash: 'H', parserVersion: parserVersionFor('pdf') };
  assert.equal(needsReparse({ hash: 'H', format: 'pdf' }, prev), false);
});

test('🔴 ядро знает аудио и видео (расхождение с платформой)', () => {
  // Раньше эти форматы были ТОЛЬКО в src/extract.ts, и веб-версия
  // классифицировала mp3 как 'unknown' — вместо внятного «расшифровка
  // доступна в десктопной версии» пользователь видел «формат не
  // поддерживается». Должна быть ОДНА таблица форматов, а не две.
  assert.equal(detect('запись.mp3', null), 'audio');
  assert.equal(detect('лекция.mp4', null), 'video');
  assert.equal(formatInfo('audio').kind, KIND.audio);
  assert.equal(formatInfo('video').kind, KIND.video);
  assert.equal(isSupported('audio'), true);
  assert.equal(isSupported('video'), true);
});
