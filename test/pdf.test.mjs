import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractPdfText, looksEmpty } from '../node/pdf.mjs';

const REAL_PDF = '/var/minis/shared/Flights_AGP-RIX_25-26_Oct_2026.pdf';

/** @returns {Promise<Uint8Array | null>} */
async function loadReal() {
  try {
    return new Uint8Array(await readFile(REAL_PDF));
  } catch {
    return null; // файла нет — тесты на реальном PDF пропускаются
  }
}

test('не-PDF и мусор не роняют парсер', () => {
  assert.equal(extractPdfText(new Uint8Array(0)), '');
  assert.equal(extractPdfText(new TextEncoder().encode('это просто текст')), '');
  assert.equal(extractPdfText(new Uint8Array([1, 2, 3, 0, 255])), '');
});

test('looksEmpty отличает пустой результат от содержательного', () => {
  assert.equal(looksEmpty(''), true);
  assert.equal(looksEmpty('   \n  '), true);
  assert.equal(looksEmpty('коротко'), true, 'скан обычно даёт обрывки');
  assert.equal(looksEmpty('а'.repeat(100)), false);
});

test('🟢 РЕАЛЬНЫЙ PDF: текст извлекается, а не ноль', async () => {
  const bytes = await loadReal();
  if (!bytes) return;
  const text = extractPdfText(bytes);
  // Первая версия парсера давала РОВНО 0 символов на этом файле —
  // фильтр шёл каскадом [/ASCII85Decode /FlateDecode], а применялся
  // только Flate. Ноль обязан быть проверен, а не принят на веру.
  assert.ok(text.length > 1000, `извлечено всего ${text.length} символов`);
  assert.equal(looksEmpty(text), false);
});

test('🔴 РЕАЛЬНЫЙ PDF: не-ASCII символы НЕ потеряны (ToUnicode)', async () => {
  const bytes = await loadReal();
  if (!bytes) return;
  const text = extractPdfText(bytes);
  // Без разбора карты ToUnicode субсет-шрифта «Málaga» приходила как
  // «M\u0080laga». Для кириллицы это означало бы потерю ВСЕГО текста.
  assert.ok(text.includes('Málaga'), 'акцентированная буква потеряна');
  assert.ok(!text.includes('M\u0080laga'), 'остался сырой код глифа');
  assert.ok(text.includes('→') || text.includes('·'), 'типографика потеряна');
});

test('РЕАЛЬНЫЙ PDF: содержимое осмысленно', async () => {
  const bytes = await loadReal();
  if (!bytes) return;
  const text = extractPdfText(bytes);
  for (const expect of ['Riga', 'Ryanair', 'October']) {
    assert.ok(text.includes(expect), `не найдено: ${expect}`);
  }
});

test('РЕАЛЬНЫЙ PDF: результат пригоден для чанкинга', async () => {
  const bytes = await loadReal();
  if (!bytes) return;
  const text = extractPdfText(bytes);
  assert.equal(text, text.trim(), 'обрезан по краям');
  assert.ok(!/\n{3,}/.test(text), 'нет длинных серий пустых строк');
  assert.ok(!/[ \t]{2,}/.test(text), 'схлопнуты повторные пробелы');
});
