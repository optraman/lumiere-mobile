import type { Caption, Episode, Movie, Season, Title } from './types';

/**
 * РАЗБОР СТРАНИЦЫ ПЛЕЕРА.
 *
 * Делается ровно то же, что у Lampac в Invoke.Embed, и теми же приметами — поэтому если они
 * поменяют разметку, сломается и там, и тут одинаково, и чинить будет по чему.
 *
 * Два вида страницы:
 *   СЕРИАЛ — в тексте есть метка `seasons:`, за ней до конца строки лежит готовый JSON со ВСЕМИ
 *            сезонами, сериями, ссылками, озвучками и субтитрами. Один запрос — весь сериал.
 *   ФИЛЬМ  — метки нет, зато есть вызов `makePlayer({…})`, из которого вынимаются поля.
 *
 * Разница с резкой принципиальная и стоит того, чтобы её назвать: там каждая серия стоила запроса,
 * а список серий приходилось выпрашивать через «Оригинал». Здесь выпрашивать нечего.
 */

/** Срез от метки до конца строки — Rx.Slice у Lampac. Хвостовая запятая убирается. */
function sliceTo(html: string, mark: string): string | null {
  const at = html.indexOf(mark);
  if (at < 0) return null;
  const end = html.indexOf('\n', at);
  const cut = html.slice(at + mark.length, end < 0 ? html.length : end).trim();
  return cut.replace(/,$/, '');
}

function one(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m ? m[1] : null;
}

/** Субтитры приходят JSON-массивом; битый массив — это ноль субтитров, а не сломанная серия. */
function captions(raw: unknown): Caption[] {
  if (!Array.isArray(raw)) return [];
  const out: Caption[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const url = (c as Record<string, unknown>).url;
    const name = (c as Record<string, unknown>).name;
    if (typeof url === 'string' && url) {
      out.push({ url, name: typeof name === 'string' && name ? name : 'Субтитры' });
    }
  }
  return out;
}

function voicesOf(raw: unknown): string[] {
  const names = (raw as { names?: unknown })?.names;
  if (!Array.isArray(names)) return [];
  return names.filter((n): n is string => typeof n === 'string' && n.length > 0);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function episodeOf(raw: unknown): Episode | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const number = typeof o.episode === 'string' ? o.episode : String(o.episode ?? '');
  const hls = str(o.hls);
  // `dasha` и `dash` — две сборки одного и того же; Lampac предпочитает dasha, и мы следом.
  const dash = str(o.dasha) ?? str(o.dash);

  // Серия без единой ссылки бесполезна: показать её в списке значит пообещать то, чего нет.
  if (!number || (!hls && !dash)) return null;

  const duration = typeof o.duration === 'number' && Number.isFinite(o.duration) ? o.duration : null;

  return {
    episode: number,
    title: str(o.title),
    durationSec: duration,
    hls,
    dash,
    captions: captions(o.cc),
    voices: voicesOf(o.audio),
    previewTemplate: str((o.preview as { src?: unknown } | undefined)?.src),
  };
}

function seasonsOf(json: string): Season[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;

  const out: Season[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const number = Number(o.season);
    if (!Number.isFinite(number)) continue;

    const episodes: Episode[] = [];
    if (Array.isArray(o.episodes)) {
      for (const e of o.episodes) {
        const ep = episodeOf(e);
        if (ep) episodes.push(ep);
      }
    }
    if (episodes.length > 0) out.push({ season: number, episodes });
  }

  if (out.length === 0) return null;
  out.sort((a, b) => a.season - b.season);
  return out;
}

function movieOf(html: string): Movie | null {
  const at = html.indexOf('makePlayer({');
  if (at < 0) return null;
  const tail = html.slice(at);

  const hls = one(tail, /hls: +"(https?:\/\/[^"]+\.m3u[^"]+)"/);
  const dash = one(tail, /dasha?: +"(https?:\/\/[^"]+\.mp[^"]+)"/);
  if (!hls && !dash) return null;

  /*
    ВСЕ НАЗВАНИЯ ДОРОЖЕК, а не первое. Раньше (как у Lampac) бралось одно имя, и в меню «Аудио»
    у фильма подписанной была только первая дорожка, а остальные шли системным «Русский» — десяток
    одинаковых строк. Здесь объект audio разбирается целиком: имена студий по порядку дорожек.
  */
  const rawAudio = one(tail, /audio: +(\{"names":\[[^\]]*\][^}]*\})/);
  let voices: string[] = [];
  if (rawAudio) {
    try {
      voices = voicesOf(JSON.parse(rawAudio));
    } catch {
      voices = [];
    }
  }
  if (!voices.length) {
    const first = one(tail, /audio: +\{"names":\["([^"]+)"/);
    if (first) voices = [first];
  }

  let cc: Caption[] = [];
  const rawCc = sliceTo(tail, 'cc:');
  if (rawCc && rawCc.startsWith('[')) {
    try {
      cc = captions(JSON.parse(rawCc));
    } catch {
      cc = [];
    }
  }

  return { hls, dash, captions: cc, voices };
}

/** Страница → фильм или сериал. Null — страница не та, которую мы умеем читать. */
export function parsePage(html: string): Title | null {
  if (html.includes('seasons:')) {
    const raw = sliceTo(html, 'seasons:');
    const seasons = raw ? seasonsOf(raw) : null;
    return seasons ? { kind: 'serial', seasons } : null;
  }

  const movie = movieOf(html);
  return movie ? { kind: 'movie', movie } : null;
}
