import { note } from '../sources/http';
import { askEmbed, EMBEDS, embedUrl, streamHeaders, withVp } from './net';
import { parsePage } from './parse';
import type { Episode, Ref, Season, Title } from './types';

export type { Caption, Episode, Movie, Season, Title, Ref } from './types';
export { streamHeaders } from './net';

/**
 * ИСТОЧНИК COLLAPS — вход для экранов.
 *
 * Весь тайтл приходит ОДНИМ запросом, поэтому и здесь всё строится вокруг одного действия: взять
 * страницу, разобрать, запомнить. Переключение серии и озвучки после этого не стоит ни одного
 * обращения к сети — ровно то, чего не удавалось добиться от резки.
 */

/**
 * ПАМЯТЬ НА ВРЕМЯ СЕАНСА.
 *
 * Страница сериала весит под мегабайт, а человек за один присест открывает пять серий подряд.
 * Качать её пять раз — это пять секунд ожидания на ровном месте. Держим разобранный результат, а не
 * текст страницы: текст больше не нужен, а памяти он занимает в сто раз больше.
 */
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_LIMIT = 6;

type Kept = { at: number; title: Title };
const cache = new Map<string, Kept>();

function keyOf(ref: Ref): string {
  if ('imdb' in ref) return `imdb:${ref.imdb}`;
  if ('kp' in ref) return `kp:${ref.kp}`;
  return `orid:${ref.orid}`;
}

function remember(key: string, title: Title): void {
  cache.delete(key);
  cache.set(key, { at: Date.now(), title });
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Забыть всё разобранное — «Очистить историю»: следующий просмотр спрашивает заново. */
export function forgetAll(): void {
  cache.clear();
}

/** Забыть разобранное: ссылки протухли или плеер их не принял. */
export function forget(ref: Ref): void {
  cache.delete(keyOf(ref));
}

/**
 * ЖИВА ЛИ ССЫЛКА.
 *
 * Срок годности написан в самом адресе параметром `t=` — это обычная секундная метка. У резки
 * это было десять цифр между двоеточиями, здесь — честный параметр; смысл тот же. Берём запас в
 * пять минут: попасть в последнюю минуту срока значит получить обрыв на середине серии.
 */
export function linkAlive(url: string): boolean {
  const m = /[?&]t=(\d{9,11})\b/.exec(url);
  if (!m) return true;
  const until = Number(m[1]) * 1000;
  if (!Number.isFinite(until)) return true;
  return Date.now() < until - 5 * 60_000;
}

/** Открыть тайтл. Null — у Collaps его нет либо страница не ответила. */
export async function open(ref: Ref, signal?: AbortSignal): Promise<Title | null> {
  const key = keyOf(ref);
  const kept = cache.get(key);
  if (kept && Date.now() - kept.at < CACHE_TTL_MS) return kept.title;

  // Основной адрес, при молчании — запасной. «Такого видео нет» второй раз не переспрашиваем.
  let html: string | null = null;
  for (const host of EMBEDS) {
    const r = await askEmbed(embedUrl(ref, host), signal);
    if (r === 'missing') return null;
    if (r) {
      html = r;
      break;
    }
  }
  if (!html) return null;

  const title = parsePage(html);
  if (title) remember(key, title);
  // Страница пришла, а разобрать её не вышло — значит, Collaps сменил разметку. Это надо видеть.
  else note(signal, { at: 'collaps · разбор страницы', status: 200, ms: 0, hint: `не разобралась (${html.length} знаков)` });
  return title;
}

/**
 * НАЙТИ СЕРИЮ.
 *
 * Номера сравниваются числами, а не строками: источник пишет «1», TMDB отдаёт 1, и сравнение
 * строк здесь ломается на первом же сезоне с двузначными номерами.
 */
export function findEpisode(seasons: Season[], season: number, episode: number): Episode | null {
  const s = seasons.find((x) => x.season === season);
  if (!s) return null;
  return s.episodes.find((e) => Number(e.episode) === episode) ?? null;
}

/** Плоский список серий по порядку — для перехода «вперёд/назад» внутри плеера. */
export function flatEpisodes(seasons: Season[]): { season: number; episode: number }[] {
  const out: { season: number; episode: number }[] = [];
  for (const s of seasons) {
    for (const e of s.episodes) {
      const n = Number(e.episode);
      if (Number.isFinite(n)) out.push({ season: s.season, episode: n });
    }
  }
  return out;
}

/**
 * ЧТО ИГРАТЬ.
 *
 * HLS первым и почти всегда: это master-плейлист, внутри которого и все качества, и все звуковые
 * дорожки. Качество при этом подбирается само, под канал, — поэтому меню качества в плеере больше
 * нет, оно было бы выбором между «авто» и «хуже, чем авто».
 */
export function streamOf(source: { hls: string | null; dash: string | null }): string | null {
  const url = source.hls ?? source.dash;
  return url ? withVp(url) : null;
}

/** Заголовки, с которыми раздача отдаёт файл. Уезжают в плеер вместе со ссылкой. */
export function playbackHeaders(): Record<string, string> {
  return streamHeaders();
}
