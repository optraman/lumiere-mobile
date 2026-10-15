// Портировано из data/tmdb/TmdbApi.kt — тот же набор эндпоинтов TMDB v3, что и в ТВ-приложении,
// только на fetch() вместо OkHttp.

import type { MediaType } from '../types/media';
import type { TmdbPageDto, TmdbDetailsDto, TmdbImagesDto, TmdbPersonDto, TmdbItemDto } from './tmdbTypes';

const BASE = 'https://api.themoviedb.org/3';
const LANG = 'ru-RU';

function apiKey(): string {
  const key = process.env.EXPO_PUBLIC_TMDB_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'Нет ключа TMDB. Скопируйте .env.example в .env и впишите свой ключ с themoviedb.org (Настройки → API).',
    );
  }
  return key;
}

function buildUrl(path: string, params: Record<string, string> = {}): string {
  const usp = new URLSearchParams({ api_key: apiKey(), language: LANG, ...params });
  return `${BASE}${path}?${usp.toString()}`;
}

/*
  ПАМЯТЬ ЗАПРОСОВ К ТМДБ — незаметная экономия.

  Одни и те же ответы приложение просило снова и снова: страница фильма при каждом открытии, сезон
  сериала при каждом переключении (и ещё раз — в ленте серий плеера), подборки при каждом возврате
  на главную. Справочник за минуты не меняется. Теперь ответ помнится 15 минут, а одновременные
  одинаковые запросы сливаются в один. Ошибка не запоминается — следующий раз спросим заново.
  Записей не больше двухсот: самые старые вытесняются.
*/
const TTL_MS = 15 * 60 * 1000;
const MAX_KEPT = 200;
const kept = new Map<string, { at: number; value: Promise<unknown> }>();

/*
  Тайм-аут 12 с: без него один зависший запрос держал всё, что его ждёт (заставку — до её
  аварийного выхода, контур загрузки на кнопке — бесконечно).
*/
const TIMEOUT_MS = 12_000;

async function fetchJson<T>(url: string): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`TMDB ${res.status} ${res.statusText} — ${url.replace(/api_key=[^&]+/, 'api_key=***')}`);
  }
  return (await res.json()) as T;
}

function getJson<T>(url: string): Promise<T> {
  const have = kept.get(url);
  if (have && Date.now() - have.at < TTL_MS) {
    // Свежее — в конец очереди вытеснения.
    kept.delete(url);
    kept.set(url, have);
    return have.value as Promise<T>;
  }
  const value = fetchJson<T>(url);
  kept.set(url, { at: Date.now(), value });
  value.catch(() => kept.delete(url));
  if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string);
  return value;
}

function tmdbPath(type: MediaType): string {
  return type === 'movie' ? 'movie' : 'tv';
}

function detailsUrl(type: MediaType, id: number): string {
  return buildUrl(`/${tmdbPath(type)}/${id}`, {
    append_to_response: 'external_ids,credits,keywords,images',
    include_image_language: 'ru,en,null',
  });
}

/** Подробности этого тайтла уже запрошены (идут или пришли)? Тогда логотип и IMDb — из них. */
function detailsInFlight(type: MediaType, id: number): Promise<TmdbDetailsDto> | null {
  const have = kept.get(detailsUrl(type, id));
  return have && Date.now() - have.at < TTL_MS ? (have.value as Promise<TmdbDetailsDto>) : null;
}

/** Логотип и IMDb-номер из полного ответа — в свои кэши (см. details). */
function primeFromDetails(type: MediaType, id: number, d: TmdbDetailsDto): void {
  const key = `${type}_${id}`;
  const raw = d as unknown as { external_ids?: { imdb_id?: string | null }; images?: { logos?: TmdbImagesDto['logos'] } };
  if (!imdbCache.has(key) && raw.external_ids) {
    const v = raw.external_ids.imdb_id;
    imdbCache.set(key, typeof v === 'string' && v.startsWith('tt') ? v : null);
  }
  if (!logoCache.has(key) && raw.images) logoCache.set(key, pickLogo(raw.images.logos ?? []));
}

async function page(path: string, params: Record<string, string> = {}): Promise<TmdbPageDto> {
  return getJson<TmdbPageDto>(buildUrl(path, params));
}

export const TmdbApi = {
  trending: () => page('/trending/all/week'),
  trendingMovies: () => page('/trending/movie/week'),
  trendingTv: () => page('/trending/tv/week'),
  popularMovies: (p = 1) => page('/movie/popular', { page: String(p) }),
  popularTv: (p = 1) => page('/tv/popular', { page: String(p) }),
  nowPlaying: (p = 1) => page('/movie/now_playing', { page: String(p) }),
  topRatedMovies: (p = 1) => page('/movie/top_rated', { page: String(p) }),
  topRatedTv: (p = 1) => page('/tv/top_rated', { page: String(p) }),
  /** Сериалы, у которых сейчас выходят серии, — «Сейчас в эфире». */
  onTheAir: (p = 1) => page('/tv/on_the_air', { page: String(p) }),

  discoverMovies: (genreId: number) =>
    page('/discover/movie', { with_genres: String(genreId), sort_by: 'popularity.desc' }),
  discoverTv: (genreId: number) =>
    page('/discover/tv', { with_genres: String(genreId), sort_by: 'popularity.desc' }),

  discover: (type: MediaType, params: Record<string, string>, p = 1) =>
    page(`/discover/${tmdbPath(type)}`, { sort_by: 'popularity.desc', ...params, page: String(p) }),

  searchMulti: (query: string) => page('/search/multi', { query, include_adult: 'false' }),

  /*
    ПОЛНЫЕ ПОДРОБНОСТИ — для страницы фильма. Из приложений к ответу оставлено только то, что
    читается: watch/providers, release_dates и content_ratings нигде не использовались, а весили
    больше всего остального ответа (разбор этого JSON — на потоке интерфейса, при каждом открытии).
    Картинки — с логотипами на ru/en/без языка: из этого же ответа берутся логотип и IMDb-номер
    (primeFromDetails), и страница больше не делает за ними два отдельных запроса.
  */
  details: (type: MediaType, id: number): Promise<TmdbDetailsDto> => {
    const v = getJson<TmdbDetailsDto>(detailsUrl(type, id));
    void v.then((d) => primeFromDetails(type, id, d)).catch(() => undefined);
    return v;
  },

  /** Лёгкие подробности — без приложений: слоган, длительность, жанры, франшиза. Для рядов и
   * списков, где нужен один-два поля, а не актёры, кадры и ключевые слова. */
  detailsLite: (type: MediaType, id: number): Promise<TmdbDetailsDto> =>
    getJson<TmdbDetailsDto>(buildUrl(`/${tmdbPath(type)}/${id}`)),

  /** Подробности с ключевыми словами — для подбора «по вкусу» (taste.ts). */
  detailsKeywords: (type: MediaType, id: number): Promise<TmdbDetailsDto> =>
    getJson<TmdbDetailsDto>(buildUrl(`/${tmdbPath(type)}/${id}`, { append_to_response: 'keywords' })),

  tvSeason: (id: number, seasonNumber: number) =>
    getJson(buildUrl(`/tv/${id}/season/${seasonNumber}`)),

  /** Справочник жанров TMDB. Нужен поиску: «ужасы» или «комедия» — это не название фильма, а
   * жанр, и человек вправе искать по нему. Список маленький и меняется раз в годы. */
  genres: (type: MediaType) =>
    getJson<{ genres: { id: number; name: string }[] }>(buildUrl(`/genre/${tmdbPath(type)}/list`)),

  /** Человек: биография плюс всё, где он снимался или что снял. combined_credits разом даёт и
   * актёрские роли, и работу в съёмочной группе — режиссёру иначе пришлось бы делать второй запрос. */
  person: (id: number) =>
    getJson<TmdbPersonDto>(buildUrl(`/person/${id}`, { append_to_response: 'combined_credits' })),

  /** Рекомендации TMDB к конкретному тайтлу — «похожее» для страницы фильма. */
  /** Коллекция (франшиза) фильма: все её части — для списка частей в плеере. */
  collection: (id: number) =>
    getJson<{ name?: string; parts?: import('./tmdbTypes').TmdbItemDto[] }>(buildUrl(`/collection/${id}`)),
  recommendations: (type: MediaType, id: number) =>
    page(`/${tmdbPath(type)}/${id}/recommendations`),

  /** Титульные логотипы («марки») — надпись с названием фильма картинкой. */
  images: (type: MediaType, id: number): Promise<TmdbImagesDto> =>
    getJson<TmdbImagesDto>(
      buildUrl(`/${tmdbPath(type)}/${id}/images`, { include_image_language: 'ru,en,null' }),
    ),
};

/**
 * СЕЗОНЫ СЕРИАЛА: номер и число серий — без всего остального.
 *
 * Нужно английским источникам: они знают серию по адресу «сериал/сезон/серия», но списка серий
 * не отдают. Список берётся у ТМДБ. Нулевой сезон («спецвыпуски») пропускается — у источников его
 * почти никогда нет.
 */
const seasonsCache = new Map<number, { season: number; episodes: number }[]>();

export async function tvSeasons(id: number): Promise<{ season: number; episodes: number }[]> {
  const kept = seasonsCache.get(id);
  if (kept) return kept;
  const dto = await getJson<{ seasons?: { season_number: number; episode_count: number }[] }>(buildUrl(`/tv/${id}`));
  const out = (dto.seasons ?? [])
    .filter((s) => s.season_number > 0 && s.episode_count > 0)
    .map((s) => ({ season: s.season_number, episodes: s.episode_count }));
  if (out.length) seasonsCache.set(id, out);
  return out;
}

/**
 * СОСТОЯНИЕ СЕРИАЛА — для списка «Новые серии»: последняя вышедшая серия и сам тайтл (карточка).
 * Запоминается на полчаса: список открывают и закрывают, а сериалы выходят раз в неделю.
 */
export type TvState = {
  dto: TmdbItemDto;
  last: { season: number; episode: number; airDate: string | null; name: string | null } | null;
};
const tvStateCache = new Map<number, { at: number; state: TvState }>();

export async function tvState(id: number): Promise<TvState> {
  const kept = tvStateCache.get(id);
  if (kept && Date.now() - kept.at < 30 * 60_000) return kept.state;
  const dto = await getJson<
    TmdbItemDto & { last_episode_to_air?: { season_number: number; episode_number: number; air_date?: string | null; name?: string | null } | null }
  >(buildUrl(`/tv/${id}`));
  const l = dto.last_episode_to_air;
  const state: TvState = {
    dto,
    last: l ? { season: l.season_number, episode: l.episode_number, airDate: l.air_date ?? null, name: l.name ?? null } : null,
  };
  tvStateCache.set(id, { at: Date.now(), state });
  return state;
}

// Портировано из TmdbRepository.logoUrl().
const logoCache = new Map<string, string | null>();

/**
 * URL титульного логотипа или null, если годного нет.
 *
 * Порядок выбора — русский, английский, БЕЗЪЯЗЫКАЯ марка, и больше НИЧЕГО. Прежним запасным
 * вариантом было «любой первый», но TMDB сортирует логотипы по голосам, а не по языку: для фильма
 * без русской и английской графики это подсовывало тайскую, грузинскую или ивритскую надпись, что
 * хуже, чем отсутствие логотипа — без него страница показывает название обычным шрифтом, а он
 * читается всегда. Пустой язык означает, что в марке вообще нет текста, значит она безопасна для всех.
 */
export async function logoUrl(type: MediaType, id: number): Promise<string | null> {
  const key = `${type}_${id}`;
  const cached = logoCache.get(key);
  if (cached !== undefined) return cached;

  // Подробности уже грузятся (страница фильма) — логотип придёт с ними, отдельный запрос не нужен.
  const inflight = detailsInFlight(type, id);
  if (inflight) {
    try {
      await inflight;
      const v = logoCache.get(key);
      if (v !== undefined) return v;
    } catch {
      /* ниже — отдельным запросом */
    }
  }

  let ok = true;
  let logos: NonNullable<TmdbImagesDto['logos']> = [];
  try {
    logos = (await TmdbApi.images(type, id)).logos ?? [];
  } catch {
    ok = false;
  }
  const url = pickLogo(logos);
  // Кэшируем ТОЛЬКО когда запрос удался: сетевой сбой тоже даёт null, и записать его означало бы
  // заморозить обрыв связи в «логотипа нет» навсегда.
  if (ok) logoCache.set(key, url);
  return url;
}

function pickLogo(logos: NonNullable<TmdbImagesDto['logos']>): string | null {
  /*
    SVG ОТБРАСЫВАЕТСЯ. TMDB отдаёт часть логотипов векторными файлами, а Image в React Native их не
    показывает вовсе — картинка просто не грузится, и название молча остаётся текстом. Растровый
    вариант почти всегда есть следующим в списке, и лучше взять его, чем «потерять» логотип.
  */
  const usable = logos.filter((l) => !(l.file_path ?? '').toLowerCase().endsWith('.svg'));

  const pick =
    usable.find((l) => l.iso_639_1 === 'ru') ??
    usable.find((l) => l.iso_639_1 === 'en') ??
    usable.find((l) => l.iso_639_1 === null) ??
    null;
  return pick ? TmdbImages.poster(pick.file_path) : null;
}

/**
 * Тот же адрес, но БЕЗ ОЖИДАНИЯ — если он уже известен.
 *
 * Нужен для карточек: заставка прогревает логотипы заранее, и если ответ уже лежит в памяти,
 * карточка обязана показать марку сразу, а не заводить обещание, дожидаться его через кадр и
 * проигрывать появление того, что и так готово. Undefined означает «ещё не спрашивали».
 */
export function logoUrlCached(type: MediaType, id: number): string | null | undefined {
  return logoCache.get(`${type}_${id}`);
}

/**
 * Постер под размер карточки. Карточка в ряду — 112–116 точек, на 3x-экране это ~340 пикселей:
 * w342 даёт ту же чёткость, что w500, но вдвое меньше файл и разжатие (а карточек на ленте — сотни).
 * Крупнее (обложки, плитки на всю ширину) — прежний w500. Та же функция — в прогреве заставки,
 * чтобы заранее скачанная картинка была ровно той, что покажет карточка.
 */
export function cardPoster(url: string, widthPt: number): string {
  return widthPt * 3 <= 360 ? url.replace('/t/p/w500/', '/t/p/w342/') : url;
}

/** URL-хелперы картинок TMDB. */
export const TmdbImages = {
  poster: (path?: string | null) => (path ? `https://image.tmdb.org/t/p/w500${path}` : null),
  backdrop: (path?: string | null) => (path ? `https://image.tmdb.org/t/p/w1280${path}` : null),
  profile: (path?: string | null) => (path ? `https://image.tmdb.org/t/p/w185${path}` : null),
  /**
   * Кадр серии для миниатюры (≈150 точек шириной). Раньше брался задник в 1280 пикселей — на
   * каждую строку списка телефон распаковывал картинку в шесть раз больше, чем показывал, и список
   * от этого лагал. 780 — с запасом для экрана с тройной плотностью, разницы не видно.
   */
  /**
   * Кадр серии. По умолчанию w300: в списках он 132–148 точек шириной, и картинка в 780 пикселей
   * только тратила память и время на разжатие (на сезоне — двадцать таких разом). Отсюда часть
   * тормозов списка серий.
   */
  still: (path?: string | null, size: 'w300' | 'w780' = 'w300') => (path ? `https://image.tmdb.org/t/p/${size}${path}` : null),
};

/**
 * IMDB-НОМЕР ТАЙТЛА.
 *
 * Источник открывается по внешнему идентификатору, а не по названию — и это главная перемена
 * против прежнего поиска по строке. Название приходилось угадывать: писать его тремя способами,
 * считать очки за совпадение, отсеивать однофамильцев и всё равно иногда попадать не в тот фильм.
 * Номер не угадывается. Он либо есть, либо его нет.
 *
 * Ответ запоминается: за сеанс один и тот же тайтл открывают по нескольку раз, а меняться этому
 * номеру неоткуда.
 */
const imdbCache = new Map<string, string | null>();

export async function imdbId(type: MediaType, id: number): Promise<string | null> {
  const key = `${type}_${id}`;
  const known = imdbCache.get(key);
  if (known !== undefined) return known;
  // Подробности уже грузятся — номер придёт в них (external_ids).
  const inflight = detailsInFlight(type, id);
  if (inflight) {
    try {
      await inflight;
      const v = imdbCache.get(key);
      if (v !== undefined) return v;
    } catch {
      /* ниже — отдельным запросом */
    }
  }

  try {
    const dto = await getJson<{ imdb_id?: string | null }>(
      buildUrl(`/${tmdbPath(type)}/${id}/external_ids`),
    );
    const value = typeof dto.imdb_id === 'string' && dto.imdb_id.startsWith('tt') ? dto.imdb_id : null;
    imdbCache.set(key, value);
    return value;
  } catch {
    // Сетевой сбой — это не «номера нет»: запоминать его значило бы запретить тайтл навсегда.
    return null;
  }
}
