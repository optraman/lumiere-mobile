import { tvSeasons } from '../tmdb';
import { browser, json, m1, note, text } from './http';
import type { Episode, Found, Source, Variant } from './types';

/**
 * VIXSRC — АНГЛИЙСКАЯ ОРИГИНАЛЬНАЯ ДОРОЖКА, ПО НОМЕРУ ТМДБ.
 *
 * Самый простой из англоязычных источников: ни ключей, ни шифра, ни номера Кинопоиска. Адрес
 * страницы строится прямо из номера ТМДБ — /movie/603, /tv/1418/1/1, — а в странице лежит готовый
 * HLS-плейлист с временным токеном. Внутри плейлиста все качества (до 1080p) и звуковые дорожки:
 * оригинал (у англоязычных тайтлов — английский) и итальянский. `lang=en` делает английскую
 * дорожкой по умолчанию.
 *
 * В меню озвучек он — ОДИН пункт «Оригинал» рядом с голосами CDNVideoHub и остальных: имя
 * источника не пишется, итальянская дорожка не показывается (hideTracks).
 *
 * Протокол — как у Stremio-дополнений StreamViX и stremio-vixsrc-addon. Разметка у них менялась,
 * поэтому разбор терпимый: ищем смысл (token, expires, url, canPlayFHD), а не точную строку, и
 * пробуем два входа — саму страницу и /api/…, который отдаёт адрес встроенного плеера.
 */
const SITE = 'https://vixsrc.to';

const pageHeaders = () => browser({ Referer: `${SITE}/` });
const streamHeaders = () => ({ 'User-Agent': browser()['User-Agent'], Referer: `${SITE}/`, Origin: SITE });

/** Плейлист из страницы плеера: адрес, токен, срок; FHD — если страница разрешает 1080p. */
export function playlistFrom(html: string): string | null {
  const at = html.indexOf('masterPlaylist');
  if (at < 0) return null;
  const block = html.slice(at, at + 1500);
  const url = m1(block, /\burl\s*:\s*['"]([^'"]+)['"]/);
  const token = m1(block, /['"]?token['"]?\s*:\s*['"]([^'"]+)['"]/);
  const expires = m1(block, /['"]?expires['"]?\s*:\s*['"]?(\d+)/);
  if (!url || !token || !expires) return null;
  const asn = m1(block, /['"]?asn['"]?\s*:\s*['"]([^'"]+)['"]/);
  const fhd = /canPlayFHD\s*=\s*true/.test(html);
  const base = url.replace(/\\\//g, '/');
  const full = base.startsWith('http') ? base : `${SITE}${base.startsWith('/') ? '' : '/'}${base}`;
  const q = [`token=${token}`, `expires=${expires}`, asn ? `asn=${asn}` : '', fhd ? 'h=1' : '', 'lang=en'].filter(Boolean);
  return `${full}${full.includes('?') ? '&' : '?'}${q.join('&')}`;
}

/** Ссылка на серию или фильм. `path` — «movie/603» или «tv/1418/1/1». */
async function playlist(path: string, signal?: AbortSignal): Promise<string | null> {
  // Вход первый: сама страница — в ней masterPlaylist.
  const page = await text(`${SITE}/${path}?lang=en`, { headers: pageHeaders(), signal });
  const direct = page ? playlistFrom(page) : null;
  if (direct) return direct;
  // Вход второй: /api/… отдаёт адрес встроенного плеера, а уже в нём masterPlaylist.
  const api = await json<{ src?: string }>(`${SITE}/api/${path}?lang=en`, { headers: pageHeaders(), signal });
  if (!api?.src) {
    if (page) note(signal, { at: 'vixsrc · разбор страницы', status: 200, ms: 0, hint: `нет masterPlaylist (${page.length} знаков)` });
    return null;
  }
  const embed = api.src.startsWith('http') ? api.src : `${SITE}${api.src}`;
  const html = await text(embed, { headers: pageHeaders(), signal });
  return html ? playlistFrom(html) : null;
}

/** Дорожки и потолок качества — из главного плейлиста. */
export function describeMaster(m3u: string): { tracks: string[]; quality: number | null } {
  const tracks: string[] = [];
  for (const line of m3u.split(/\r?\n/)) {
    if (!/^#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(line)) continue;
    const name = /NAME="([^"]+)"/i.exec(line)?.[1] ?? /LANGUAGE="([^"]+)"/i.exec(line)?.[1];
    if (name && !tracks.includes(name)) tracks.push(name);
  }
  let quality: number | null = null;
  for (const m of m3u.matchAll(/RESOLUTION=\d+x(\d+)/gi)) quality = Math.max(quality ?? 0, Number(m[1]));
  return { tracks, quality };
}

export const vixsrc: Source = {
  id: 'vixsrc',
  typical: 1080,
  name: 'VixSrc',
  movie: true,
  serial: true,
  needs: ['tmdb'],
  async open(ids, signal) {
    if (!ids.tmdb) return null;
    const headers = streamHeaders();

    if (ids.kind === 'movie') {
      const url = await playlist(`movie/${ids.tmdb}`, signal);
      if (!url) return null;
      // Дорожки читаем сразу: по ним выбор видит оригинал и число голосов.
      const master = await text(url, { headers, signal, timeoutMs: 8_000 });
      const d = master ? describeMaster(master) : { tracks: [], quality: null };
      // В меню — просто «Оригинал», без имени источника и без итальянской дорожки (решение Марка).
      const variant: Variant = {
        voice: 'Оригинал',
        quality: d.quality ? `${d.quality}p` : null,
        url,
        headers,
        hideTracks: true,
      };
      return { kind: 'movie', variants: [variant] } satisfies Found;
    }

    /*
      СЕРИАЛ. Списка серий источник не даёт — он берётся у ТМДБ, а наличие проверяется одной
      первой серией: если её нет, сериала у источника нет вовсе, и в выбор он не попадает.
      Остальные серии — ссылка по запросу, в момент включения (токен живёт недолго).
    */
    const seasons = await tvSeasons(ids.tmdb).catch((e: unknown) => {
      note(signal, { at: 'api.themoviedb.org · сезоны', status: 'нет связи', ms: 0, hint: String((e as Error)?.message ?? e).slice(0, 90) });
      return [];
    });
    if (seasons.length === 0) return null;
    const first = seasons[0];
    const probe = await playlist(`tv/${ids.tmdb}/${first.season}/1`, signal);
    if (!probe) return null;

    const out = seasons.map(({ season, episodes }) => ({
      season,
      episodes: Array.from({ length: episodes }, (_, i): Episode => {
        const episode = i + 1;
        const path = `tv/${ids.tmdb}/${season}/${episode}`;
        return {
          episode,
          title: null,
          variants: [
            {
              voice: 'Оригинал',
              quality: null,
              hideTracks: true,
              // Первая серия уже открыта — её ссылку не спрашиваем второй раз.
              ...(season === first.season && episode === 1 ? { url: probe } : { resolve: (sig?: AbortSignal) => playlist(path, sig) }),
              headers,
            },
          ],
        };
      }),
    }));
    return { kind: 'serial', seasons: out } satisfies Found;
  },
};
