import { failOf, hintOf, note, traceSignal, where, type Step } from './http';
import { search, SOURCES, type Hit } from './index';
import type { Ids, Variant } from './types';

/**
 * ПРОВЕРКА ИСТОЧНИКОВ ДО САМОГО КАДРА.
 *
 * «Нашёл» — ещё не «работает». Цепочка у каждого источника длинная, и рваться она может на любом
 * звене: тайтл нашёлся → ссылку на серию дали → плейлист открылся → плейлист качества открылся →
 * первый кусок видео отдали. Плеер видит только конец цепочки: «не поднялся» — и молча берёт
 * следующий источник. Так и выходит, что «работает только один»: остальные рвутся где-то в
 * середине, а снаружи этого не видно.
 *
 * Здесь цепочка проходится целиком, ровно как её пройдёт плеер — с теми же заголовками, — и для
 * каждого звена пишется, что ответили. Этим пользуются и экран настроек, и tools/sources-probe.js.
 */

export type Target = { season: number; episode: number } | null;

export type StreamCheck = {
  /** Дошли ли до куска видео. */
  ok: boolean;
  /** Какое звено оборвалось, если не дошли. */
  broke?: 'плейлист' | 'плейлист качества' | 'кусок видео' | 'файл';
  steps: Step[];
};

export type SourceCheck = {
  id: string;
  name: string;
  found: boolean;
  ms: number;
  note?: string;
  /** Запросы поиска. */
  steps: Step[];
  voices?: number;
  hasTarget?: boolean;
  /** Получилась ли ссылка; сколько вариантов перебрали. */
  link?: boolean;
  tried?: number;
  linkSteps?: Step[];
  stream?: StreamCheck;
};

export type TitleCheck = {
  kp: number | null | undefined;
  kpSteps: Step[];
  sources: SourceCheck[];
};

function variantsFor(hit: Hit, target: Target): Variant[] {
  if (!target) return hit.found.kind === 'movie' ? hit.found.variants : [];
  if (hit.found.kind !== 'serial') return [];
  return (
    hit.found.seasons.find((s) => s.season === target.season)?.episodes.find((e) => e.episode === target.episode)
      ?.variants ?? []
  );
}

const TIMEOUT_MS = 10_000;

/** Один запрос для проверки потока. `range` — только начало: целиком фильм качать незачем. */
async function peek(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  range: boolean,
): Promise<{ status: number; text: string; url: string } | null> {
  const ctrl = new AbortController();
  const started = Date.now();
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    ctrl.abort();
  }, TIMEOUT_MS);
  const onOuter = () => ctrl.abort();
  signal.addEventListener('abort', onOuter);
  try {
    const res = await fetch(url, { headers: range ? { ...headers, Range: 'bytes=0-1023' } : headers, signal: ctrl.signal });
    const type = res.headers.get('content-type') ?? '';
    // Текст читаем только у плейлистов; у видео достаточно кода ответа.
    const textual = !range || /mpegurl|text|json|xml/i.test(type);
    const text = textual ? await res.text() : '';
    if (!textual) ctrl.abort();
    note(signal, {
      at: where(url),
      status: res.status,
      ms: Date.now() - started,
      hint: textual ? hintOf(text.slice(0, 200)) : type || undefined,
    });
    return { status: res.status, text, url: res.url || url };
  } catch (e) {
    note(signal, { at: where(url), status: late ? 'срок' : 'нет связи', ms: Date.now() - started, hint: late ? undefined : failOf(e) });
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onOuter);
  }
}

/** Первая ссылка-строка плейлиста (не комментарий), разрешённая относительно него самого. */
function firstUri(playlist: string, base: string): string | null {
  const line = playlist
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  if (!line) return null;
  return resolveUri(line, base);
}

/**
 * Относительная ссылка плейлиста → полная. Своё, а не `new URL(…, base)`: в React Native
 * встроенный URL с базой склеивает строки как попало, и проверка шла бы не по тому адресу.
 */
export function resolveUri(ref: string, base: string): string | null {
  if (/^https?:\/\//i.test(ref)) return ref;
  const m = /^(https?:)\/\/([^/?#]+)([^?#]*)/i.exec(base);
  if (!m) return null;
  const [, scheme, host, path] = m;
  if (ref.startsWith('//')) return `${scheme}${ref}`;
  if (ref.startsWith('/')) return `${scheme}//${host}${ref}`;
  const dir = path.slice(0, path.lastIndexOf('/') + 1) || '/';
  return `${scheme}//${host}${dir}${ref}`;
}

/**
 * ПРОЙТИ ПОТОК, КАК ПЛЕЕР: плейлист → плейлист качества → первый кусок видео.
 * Для обычного файла (mp4) — просто начало файла.
 */
export async function checkStream(url: string, headers: Record<string, string>, outer: AbortSignal): Promise<StreamCheck> {
  const ctrl = new AbortController();
  outer.addEventListener('abort', () => ctrl.abort(), { once: true });
  const steps = traceSignal(ctrl.signal);
  const ok2 = (r: { status: number } | null) => !!r && r.status >= 200 && r.status < 300;

  const isPlaylist = /\.m3u8(\?|$|#)/i.test(url) || !/\.(mp4|mkv|webm)(\?|$|#)/i.test(url);
  if (!isPlaylist) {
    const r = await peek(url, headers, ctrl.signal, true);
    return ok2(r) ? { ok: true, steps } : { ok: false, broke: 'файл', steps };
  }

  const top = await peek(url, headers, ctrl.signal, false);
  if (!ok2(top) || !top!.text.includes('#EXTM3U')) {
    // Не плейлист, а файл с непривычным адресом — тоже бывает.
    if (ok2(top) && !top!.text) return { ok: true, steps };
    return { ok: false, broke: 'плейлист', steps };
  }
  let media = top!;
  if (/#EXT-X-STREAM-INF/i.test(top!.text)) {
    const next = firstUri(top!.text, top!.url);
    const r = next ? await peek(next, headers, ctrl.signal, false) : null;
    if (!ok2(r) || !r!.text.includes('#EXTM3U')) return { ok: false, broke: 'плейлист качества', steps };
    media = r!;
  }
  const seg = firstUri(media.text, media.url);
  const r = seg ? await peek(seg, headers, ctrl.signal, true) : null;
  return ok2(r) ? { ok: true, steps } : { ok: false, broke: 'кусок видео', steps };
}

/** Сколько вариантов пробовать получить ссылку, прежде чем сказать «ссылок не даёт». */
const LINK_TRIES = 3;

/** Проверить все источники на одном тайтле — от поиска до первого куска видео. */
export async function checkTitle(ids: Ids, target: Target, signal: AbortSignal): Promise<TitleCheck> {
  const s = search(ids, signal);
  const [outcomes, hits] = await Promise.all([s.report(), s.settled()]);
  const sources = await Promise.all(
    outcomes.map(async (o): Promise<SourceCheck> => {
      const row: SourceCheck = { id: o.source.id, name: o.source.name, found: o.ok, ms: o.ms, note: o.note, steps: o.steps };
      const hit = hits.find((h) => h.source.id === o.source.id);
      if (!hit) return row;
      const vs = variantsFor(hit, target);
      row.hasTarget = vs.length > 0;
      row.voices = new Set(vs.flatMap((v) => (v.tracks?.length ? v.tracks : [v.voice]))).size;
      if (!vs.length) return row;

      const ctrl = new AbortController();
      signal.addEventListener('abort', () => ctrl.abort(), { once: true });
      row.linkSteps = traceSignal(ctrl.signal);
      row.tried = 0;
      for (const v of vs.slice(0, LINK_TRIES)) {
        row.tried += 1;
        let url: string | null = v.url ?? null;
        if (!url && v.resolve) url = await v.resolve(ctrl.signal).catch(() => null);
        if (!url) continue;
        row.link = true;
        row.stream = await checkStream(url, v.headers, signal);
        if (row.stream.ok) break;
      }
      if (!row.link) row.link = false;
      return row;
    }),
  );
  return { kp: s.kp().value, kpSteps: s.kp().steps, sources };
}

/** Короткий вывод для человека: где оборвалось. */
export function verdict(c: SourceCheck): string {
  if (!c.found) {
    const last = [...c.steps].reverse().find((x) => x.status !== 200) ?? c.steps[c.steps.length - 1];
    return last ? `${c.note ?? 'нет'} · ${last.at} → ${last.status}` : c.note ?? 'нет';
  }
  if (c.hasTarget === false) return 'нашёл, но без этой серии';
  if (!c.link) {
    const last = c.linkSteps?.[c.linkSteps.length - 1];
    return `нашёл, ссылку не дал${last ? ` · ${last.at} → ${last.status}` : ''}`;
  }
  if (!c.stream?.ok) {
    const last = c.stream?.steps[c.stream.steps.length - 1];
    return `ссылка есть, ${c.stream?.broke ?? 'поток'} не открылся${last ? ` · ${last.status}` : ''}`;
  }
  return `работает · ${c.voices ?? 0} озв. · ${(c.ms / 1000).toFixed(1)} с`;
}

export { SOURCES };
