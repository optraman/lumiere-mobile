import { useSyncExternalStore } from 'react';

/**
 * ЖУРНАЛ ВЫБОРА ИСТОЧНИКА — то же, что пишется в консоль Metro, но видимое на телефоне.
 *
 * Консоль есть только при подключённом компьютере. А вопрос «почему играет этот балансер, а не
 * другой» возникает как раз тогда, когда смотришь кино. Поэтому последние строки держатся в
 * памяти и показываются в настройках: кто ответил, кто победил, чья ссылка не открылась и с
 * какой ошибкой плеер перешёл к следующему.
 */
const LIMIT = 80;
let lines: string[] = [];
const listeners = new Set<() => void>();

export function say(line: string): void {
  console.log(line);
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  lines = [...lines, `${hh}:${mm}:${ss} ${line.replace(/^ЛЮМЬЕР · /, '')}`].slice(-LIMIT);
  listeners.forEach((cb) => cb());
}

export function clearJournal(): void {
  lines = [];
  listeners.forEach((cb) => cb());
}

export function useJournal(): string[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => lines,
  );
}
