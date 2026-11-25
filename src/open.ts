// Открытие папки в файловом менеджере системы.
//
// Команда зависит от платформы, и ни одна не универсальна. Проверяется
// КОД ВОЗВРАТА, а не факт запуска: на Linux без графической оболочки
// xdg-open существует, но завершается ошибкой, и молча отрапортовать
// «открыто» было бы враньём.

import { platform } from 'node:os';

export interface OpenResult {
  ok: boolean;
  command?: string;
  error?: string;
}

/** Кандидаты в порядке предпочтения для текущей системы. */
function candidates(): string[][] {
  switch (platform()) {
    case 'darwin':
      return [['open']];
    case 'win32':
      return [['explorer']];
    default:
      // xdg-open — стандарт freedesktop; остальные на случай его отсутствия
      return [['xdg-open'], ['gio', 'open'], ['nautilus'], ['dolphin'], ['thunar']];
  }
}

export async function openFolder(path: string): Promise<OpenResult> {
  const tried: string[] = [];

  for (const cmd of candidates()) {
    const [bin, ...pre] = cmd as [string, ...string[]];
    // Проверяем наличие бинаря, иначе spawn бросит исключение
    const which = Bun.spawnSync(['sh', '-c', `command -v ${bin}`]);
    if (which.exitCode !== 0) {
      tried.push(`${bin} (не найден)`);
      continue;
    }

    const proc = Bun.spawnSync([bin, ...pre, path], {
      stdout: 'ignore', stderr: 'pipe',
    });
    if (proc.exitCode === 0) return { ok: true, command: bin };

    const err = proc.stderr?.toString().trim().split('\n')[0] ?? `код ${proc.exitCode}`;
    tried.push(`${bin}: ${err}`);
  }

  return {
    ok: false,
    error: tried.length > 0
      ? tried.join('; ')
      : 'не найдено ни одной команды открытия',
  };
}
