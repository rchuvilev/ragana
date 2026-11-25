import { test, expect } from 'bun:test';
import {
  scriptProfile, isMostlyLatin, tesseractLangs, florenceDecision,
} from '../src/lang.ts';

test('профиль письменностей: кириллица', () => {
  const p = scriptProfile('Франшиза составляет триста евро за случай');
  expect(p.cyrillic).toBeGreaterThan(0.95);
  expect(p.latin).toBe(0);
});

test('профиль письменностей: латиница', () => {
  const p = scriptProfile('Deductible is three hundred euro per claim');
  expect(p.latin).toBeGreaterThan(0.95);
  expect(p.cyrillic).toBe(0);
});

test('🔴 цифры и пунктуация НЕ искажают профиль', () => {
  // В таблице цифр больше, чем букв; если считать их, язык определится
  // неверно на любом финансовом документе.
  const p = scriptProfile('115:20 20:50 4h 30m — 143 €, 322 €');
  expect(p.letters).toBeLessThan(6);
  const p2 = scriptProfile('Франшиза 300 300 300 300 евро 2026-11-25');
  expect(p2.cyrillic).toBeGreaterThan(0.95);
});

test('смешанный текст даёт обе доли', () => {
  const p = scriptProfile('Франшиза deductible составляет');
  expect(p.cyrillic).toBeGreaterThan(0.3);
  expect(p.latin).toBeGreaterThan(0.2);
});

test('пустой текст не ломает', () => {
  const p = scriptProfile('');
  expect(p.letters).toBe(0);
  expect(p.cyrillic).toBe(0);
  expect(scriptProfile('123 456 !!!').letters).toBe(0);
});

test('isMostlyLatin: английский да, русский нет', () => {
  expect(isMostlyLatin('Deductible is three hundred euro per every claim')).toBe(true);
  expect(isMostlyLatin('Франшиза составляет триста евро за каждый случай')).toBe(false);
});

test('🔴 единичная кириллица не отменяет латиницу', () => {
  // Порог 0.85, а не 1.0: имена и цитаты встречаются в любом тексте
  const text = 'The document mentions Франшиза as a technical term here and there';
  expect(isMostlyLatin(text)).toBe(true);
});

test('🔴 короткий обрывок — отказ, а не угадывание', () => {
  // На двух словах язык определять бессмысленно, ошибка дороже отказа
  expect(isMostlyLatin('OK yes')).toBe(false);
  expect(isMostlyLatin('Hello')).toBe(false);
});

test('выбор языков tesseract по алфавиту', () => {
  expect(tesseractLangs('Франшиза составляет триста евро за случай')).toBe('rus');
  expect(tesseractLangs('Deductible is three hundred euro per claim')).toBe('eng');
  const mixed = tesseractLangs('Франшиза deductible составляет euro полис claim');
  expect(mixed).toContain('rus');
  expect(mixed).toContain('eng');
});

test('без подсказки — запасной набор', () => {
  // Передавать tesseract все 66 языков нельзя: это замедляет работу и
  // роняет точность из-за подстановки похожих букв.
  expect(tesseractLangs('')).toBe('rus+eng');
  expect(tesseractLangs('123')).toBe('rus+eng');
  expect(tesseractLangs('abc', 'deu')).toBe('deu');
});

test('🟢 Florence-2 НЕ зовётся, когда tesseract что-то нашёл', () => {
  // Главное решение, основанное на замере: Florence-2 ошибается даже на
  // английском («Deductible» -> «Deutscible») и отстаёт в 140 раз.
  expect(florenceDecision('Франшиза составляет 300 евро')).toBe('skip');
  expect(florenceDecision('Deductible is 300 euro')).toBe('skip');
});

test('🟢 Florence-2 зовётся за ОПИСАНИЕМ на пустом результате', () => {
  // Это его единственная ниша: картинка без текста, где tesseract
  // возвращает пустоту, а файл иначе молча выпал бы из индекса.
  expect(florenceDecision('')).toBe('caption');
  expect(florenceDecision('   \n  ')).toBe('caption');
  expect(florenceDecision('ab')).toBe('caption');
});
