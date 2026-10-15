import { browser, json, text } from './http';
import type { Episode, Found, Source, Variant } from './types';

/**
 * CDNVIDEOHUB — ПЛЕЕР, НА КОТОРОМ ЖИВЁТ LOSTFILM.
 *
 * Один запрос по номеру Кинопоиска даёт весь список: сезоны, серии и озвучки студий. Ссылка на
 * конкретную серию — второй запрос по её `vkId`, поэтому он откладывается до нажатия.
 * Протокол: Lampac, Modules/OnlineRUS/CDNvideohub.
 */
const API = 'https://plapi.cdnvideohub.com';
const PLAYER = 'https://player.cdnvideohub.com';

const apiHeaders = () =>
  browser({
    referer: 'http://lostfilm5.org',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    Accept: 'application/json, text/plain, */*',
  });

const streamHeaders = () =>
  browser({
    origin: PLAYER,
    referer: `${PLAYER}/`,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    Accept: '*/*',
  });

type Item = { season?: number; episode?: number; voiceStudio?: string; voiceType?: string; vkId?: string | number };

/*
  Ответ по vkId — один на серию: из него берутся и поток (hlsUrl), и готовые файлы по качествам
  (mpeg…Url) для загрузки. Запрос не повторяется, пока ответ свежий: ссылки живут недолго, но
  пару минут — точно.
*/
const videoCache = new Map<string, { at: number; raw: Promise<string | null> }>();
function videoRaw(vkId: string | number, signal?: AbortSignal): Promise<string | null> {
  const key = String(vkId);
  const have = videoCache.get(key);
  if (have && Date.now() - have.at < 120_000) return have.raw;
  const raw = text(`${API}/api/v1/player/sv/video/${vkId}`, { headers: apiHeaders(), signal }).catch(() => null);
  videoCache.set(key, { at: Date.now(), raw });
  void raw.then((r) => {
    if (!r) videoCache.delete(key);
  });
  return raw;
}

/** Строка JSON без разбора — как у Lampac: без экранирования и с «u0026» вместо «&». */
const clean = (s: string) => s.replace(/u0026/g, '&').replace(/\\/g, '');

function resolver(vkId: string | number) {
  return async (signal?: AbortSignal) => {
    const raw = await videoRaw(vkId, signal);
    if (!raw) return null;
    // Ровно как у Lampac: строка между "hlsUrl":" и следующей кавычкой, без экранирования.
    const at = raw.indexOf('"hlsUrl":"');
    if (at < 0) return null;
    const rest = raw.slice(at + 10);
    const url = clean(rest.slice(0, rest.indexOf('"')));
    return url.startsWith('http') ? url : null;
  };
}

/** Высота кадра по имени качества у VK: mpegLowUrl → 360 и т. д. */
const HEIGHTS: Record<string, number> = {
  tiny: 144,
  lowest: 240,
  low: 360,
  medium: 480,
  high: 720,
  fullhd: 1080,
  quadhd: 1440,
  qhd: 1440,
  '2k': 1440,
  '4k': 2160,
  ultrahd: 2160,
};

/**
 * ГОТОВЫЕ MP4 ДЛЯ ЗАГРУЗКИ. Рядом с hlsUrl VK кладёт обычные файлы по качествам
 * (mpegFullHdUrl, mpegHighUrl…). Если они есть — загрузка берёт файл, а не поток: его не надо
 * собирать из кусков. Нет их — пустой список, и загрузка идёт потоком, как раньше.
 */
function filesOf(vkId: string | number) {
  return async (signal?: AbortSignal) => {
    const raw = await videoRaw(vkId, signal);
    if (!raw) return [];
    const out: { url: string; height: number }[] = [];
    const re = /"mpeg(\w+?)Url":"([^"]*)"/g;
    for (let m = re.exec(raw); m; m = re.exec(raw)) {
      const url = clean(m[2]);
      const height = HEIGHTS[m[1].toLowerCase()] ?? 0;
      if (url.startsWith('http') && height) out.push({ url, height });
    }
    return out;
  };
}

function voiceOf(it: Item): string {
  return (it.voiceStudio || it.voiceType || 'Озвучка').trim();
}

export const cdnvideohub: Source = {
  id: 'cdnvideohub',
  typical: 1080,
  name: 'CDNVideoHub',
  movie: true,
  serial: true,
  needs: ['kp'],
  async open(ids, signal) {
    if (!ids.kp) return null;
    const data = await json<{ isSerial?: boolean; items?: Item[] }>(
      `${API}/api/v1/player/sv/playlist?pub=12&aggr=kp&id=${ids.kp}`,
      { headers: apiHeaders(), signal },
    );
    const items = (data?.items ?? []).filter((i) => i.vkId);
    if (items.length === 0) return null;

    const headers = streamHeaders();
    const variant = (it: Item): Variant => ({
      voice: voiceOf(it),
      quality: null,
      resolve: resolver(it.vkId as string | number),
      files: filesOf(it.vkId as string | number),
      headers,
    });

    if (!data?.isSerial) {
      return { kind: 'movie', variants: items.map(variant) } satisfies Found;
    }

    const bySeason = new Map<number, Map<number, Episode>>();
    for (const it of items) {
      const s = Number(it.season);
      const e = Number(it.episode);
      if (!(s > 0) || !(e > 0)) continue;
      const eps = bySeason.get(s) ?? new Map<number, Episode>();
      const ep = eps.get(e) ?? { episode: e, title: null, variants: [] };
      // Одна студия — один вариант: повторы в выдаче бывают, второй такой же не нужен.
      if (!ep.variants.some((v) => v.voice === voiceOf(it))) ep.variants.push(variant(it));
      eps.set(e, ep);
      bySeason.set(s, eps);
    }
    const seasons = [...bySeason.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([season, eps]) => ({ season, episodes: [...eps.values()].sort((a, b) => a.episode - b.episode) }));
    return seasons.length ? { kind: 'serial', seasons } : null;
  },
};
