// Цвета терминала.
//
// Вынесено из main.ts, tui.ts и scripts/common.ts, где один и тот же
// набор был скопирован трижды: расхождение в палитре между командой и
// интерфейсом выглядело бы как случайная непоследовательность.
//
// Коды ANSI, а не библиотека: это десять строк, и тянуть зависимость в
// бинарь ради них незачем.

const wrap = (code: string) => (s: string): string => `\x1b[${code}m${s}\x1b[0m`;

export const C = {
  /** Жирный — заголовки и ключевые значения. */
  b: wrap('1'),
  /** Приглушённый — второстепенное: пути, тайминги, подсказки. */
  dim: wrap('2'),
  /** Инверсия — клавиши меню. */
  inv: wrap('7'),
  g: wrap('32'),
  y: wrap('33'),
  r: wrap('31'),
  c: wrap('36'),
};

/** Отключает раскраску: нужно при выводе в файл или пайп. */
export function plain(): typeof C {
  const asis = (s: string): string => s;
  return { b: asis, dim: asis, inv: asis, g: asis, y: asis, r: asis, c: asis };
}

/**
 * Палитра по окружению.
 *
 * Вне TTY управляющие последовательности превратили бы вывод в мусор —
 * особенно в --json, который должен парситься.
 */
export function colors(force?: boolean): typeof C {
  if (force === true) return C;
  if (force === false) return plain();
  return process.stdout.isTTY === true ? C : plain();
}
