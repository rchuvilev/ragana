// Отрисовка прогресса в терминале.
//
// Индексация идёт минутами (замерено: 47 с на 3 файла, из них 6 с —
// загрузка модели), поэтому молчащий вывод выглядит как зависание.
// Показываем фазу, файл и оценку оставшегося времени.

import { basename } from 'node:path';
import type { Progress } from './types.ts';

const PHASE_LABEL: Record<Progress['phase'], string> = {
  scan: 'обход',
  extract: 'расшифровка',
  chunk: 'разбиение',
  embed: 'векторизация',
  store: 'запись',
  done: 'готово',
};

/** Секунды -> «2 мин 15 с». */
export function humanEta(sec: number): string {
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m} мин` : `${m} мин ${s} с`;
}

export function formatProgress(p: Progress): string {
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  const bar = p.total > 0 ? `${String(pct).padStart(3)}%` : '   ';
  const phase = PHASE_LABEL[p.phase];
  const file = p.file ? ` ${basename(p.file)}` : '';
  // Примечание не печатается, если оно повторяет название фазы:
  // выходило «обход обход папки», что выглядит как сбой вывода.
  const note = p.note && p.note !== phase && !p.note.startsWith(phase)
    ? ` ${p.note}` : '';
  const eta = p.etaSec !== undefined && p.etaSec > 0
    ? `  ещё ~${humanEta(p.etaSec)}` : '';
  return `${bar} ${phase}${file}${note}${eta}`;
}

const isTty = process.stdout.isTTY === true;
// TUI запускает бинарь дочерним процессом, где TTY нет. Без этого флага
// прогресс молчал бы, и интерфейс показывал бы пустой экран всю
// индексацию — то есть выглядел бы зависшим.
const plain = process.env.RAGANA_PLAIN_PROGRESS === '1';
let lastLength = 0;
let lastPlain = '';

/**
 * Пишет прогресс в одну строку.
 *
 * Вне TTY возврат каретки превратил бы вывод в мусор, поэтому там
 * печатаются обычные строки — но только при изменении текста, иначе
 * на каждую пачку векторов приходилась бы новая строка.
 */
export function renderProgress(p: Progress): void {
  if (plain) {
    if (p.phase === 'done') return;
    const line = formatProgress(p).trim();
    if (line !== lastPlain) {
      lastPlain = line;
      process.stdout.write(line + '\n');
    }
    return;
  }
  if (!isTty) return;
  if (p.phase === 'done') {
    process.stdout.write(`\r${' '.repeat(lastLength)}\r`);
    lastLength = 0;
    return;
  }
  const line = formatProgress(p);
  const pad = Math.max(0, lastLength - line.length);
  process.stdout.write(`\r\x1b[2m${line}\x1b[0m${' '.repeat(pad)}`);
  lastLength = line.length;
}
