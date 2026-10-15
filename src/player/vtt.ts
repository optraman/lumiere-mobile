/**
 * ВНЕШНИЕ СУБТИТРЫ — СВОИМИ РУКАМИ.
 *
 * Источник отдаёт субтитры отдельными файлами (.vtt, иногда .srt), а expo-video внешние дорожки не
 * поддерживает: его subtitleTrack умеет только то, что вшито в сам поток. Поэтому файл читается
 * здесь, разбирается на реплики и рисуется поверх кадра обычным текстом.
 *
 * Так было с прошлым источником, так осталось и с Collaps: в его ответе субтитры лежат списком
 * cc: [{url, name}] — ровно такими же отдельными файлами.
 */

export type Cue = {
  /** Секунды от начала. */
  from: number;
  to: number;
  text: string;
};

/** `00:01:02.345`, `01:02.345`, `00:01:02,345` — все три написания встречаются. */
const STAMP = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const LINE = new RegExp(`${STAMP.source}\\s*-->\\s*${STAMP.source}`);

function seconds(h: string | undefined, m: string, s: string, ms: string): number {
  return (
    Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000
  );
}

/**
 * Убираем разметку, которую показывать нельзя: теги вида `<i>`, `<c.name>`, позиционные указания
 * ASS (`{\an8}`) и `&nbsp;`. Курсив мы не рисуем, а угловые скобки в кадре выглядят поломкой.
 */
function clean(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * Разбор WebVTT и SRT одним проходом.
 *
 * Отличаются они мелочами (заголовок `WEBVTT`, точка против запятой в долях секунды, номер реплики
 * отдельной строкой), и держать два разборщика незачем: строку со стрелкой узнаём по виду, всё до
 * следующей пустой строки считаем текстом реплики.
 */
export function parseCues(raw: string): Cue[] {
  const out: Cue[] = [];
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = LINE.exec(lines[i]);
    if (!m) continue;
    const from = seconds(m[1], m[2], m[3], m[4]);
    const to = seconds(m[5], m[6], m[7], m[8]);
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && lines[j].trim() !== ''; j++) body.push(lines[j]);
    i += body.length;
    const text = clean(body.join('\n'));
    if (text) out.push({ from, to, text });
  }
  return out.sort((a, b) => a.from - b.from);
}

/**
 * Скачать и разобрать дорожку.
 *
 * Заголовки — те же, что у потока: субтитры лежат на той же раздаче, и приходить к ней надо тем же
 * гостем, иначе она отвечает отказом.
 */
export async function loadCues(url: string, headers?: Record<string, string>): Promise<Cue[]> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Субтитры не отдались (${res.status})`);
  return parseCues(await res.text());
}

/**
 * Реплика на данный момент.
 *
 * Список отсортирован, и его можно резать пополам, но реплик в фильме тысячи, а время идёт вперёд
 * по две проверки в секунду. Поэтому ищем от подсказки — индекса, на котором остановились в
 * прошлый раз: при обычном просмотре это один шаг, а двоичный поиск остаётся для перемотки.
 */
export function cueAt(cues: Cue[], seconds: number, hint = 0): { index: number; cue: Cue | null } {
  if (cues.length === 0) return { index: 0, cue: null };
  let i = Math.min(Math.max(hint, 0), cues.length - 1);
  // Ушли назад (перемотка) — ищем заново пополам, вперёд — просто шагаем.
  if (cues[i].from > seconds) {
    let lo = 0;
    let hi = cues.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].to < seconds) lo = mid + 1;
      else hi = mid;
    }
    i = lo;
  } else {
    while (i + 1 < cues.length && cues[i].to < seconds) i++;
  }
  const cue = cues[i];
  return { index: i, cue: cue && cue.from <= seconds && seconds <= cue.to ? cue : null };
}
