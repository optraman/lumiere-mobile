// Портировано из TmdbRepository.homeFeed()/moviesFeed()/tvFeed(). Состав и ПОРЯДОК рядов взяты
// один в один из ТВ-версии — это не «набор популярных рядов вообще», а конкретная лента «Люмьера».

import { Image } from 'react-native';
import { TmdbApi, logoUrl } from './tmdb';
import { primeLogoLook } from './logoLook';
import { mapItems } from './mapper';
import { curated, mainstream } from './curate';
import { liveRowSpec } from './liveRow';
import { HALLOWEEN_ROWS, OCCASIONS, dayOfYear, isHalloween, isNewYear, occasionToday, paramsOf, type Occasion } from './occasions';
import type { MediaItem } from '../types/media';
import { sagaRows, tasteRows } from './taste';
import { titlesByRecent, titleKey } from '../data/watchProgress';
import { genreAffinity, isDisliked } from '../data/feedback';

/*
  РАЗНООБРАЗИЕ (жалоба Марка: «в пунктах слишком однообразные фильмы»).
    • Один тайтл — в одном ряду: идём по ленте сверху вниз, и всё, что уже показано выше, из
      следующих рядов убирается (кроме «Топ 10» — он про место, а не про подборку).
    • Подборки по жанрам и поводам берут не первую страницу TMDB всегда, а одну из трёх — по дню
      года, и внутри ряда порядок перемешивается раз в день: лента каждый день другая.
    • Уже досмотренное и то, что отмечено «не нравится», в ленту не попадает.
*/
const DAY = Math.floor(Date.now() / 86_400_000);
const dayPage = (salt: number) => ((DAY + salt) % 3) + 1;

function dayShuffle<T>(list: T[], salt: number): T[] {
  const a = [...list];
  let x = (DAY * 31 + salt * 17) | 1;
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Оценки пальцем действуют сразу, без пересборки ленты: «не нравится» убирает тайтл из всех рядов,
 * а обычные ряды постеров пересортировываются по сумме оценок жанров (−3…3), как у Влада.
 * «Топ 10», «Сейчас в кино» и персональные ряды свой порядок сохраняют.
 */
export function personalize(rows: FeedRow[]): FeedRow[] {
  const aff = genreAffinity();
  const score = (m: MediaItem) => Math.max(-3, Math.min(3, m.genreIds.reduce((n, g) => n + (aff.get(g) ?? 0), 0)));
  return rows
    .map((r) => {
      if (r.style === 'MOOD') return r;
      let items = r.items.filter((m) => !isDisliked(m.type, m.id));
      if (aff.size && r.style === 'POSTER' && !r.key.startsWith('TASTE') && !r.key.startsWith('SAGA')) {
        items = items.map((m, i) => ({ m, i, s: score(m) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.m);
      }
      return items.length === r.items.length && items.every((m, i) => m === r.items[i]) ? r : { ...r, items };
    })
    .filter((r) => r.style === 'MOOD' || r.items.length > 0);
}

function diversify(rows: FeedRow[]): FeedRow[] {
  const shown = new Set<string>();
  const watched = new Set(titlesByRecent().filter((t) => t.finished).map((t) => titleKey(t.type, t.id)));
  const out: FeedRow[] = [];
  for (const r of rows) {
    if (r.style === 'MOOD') {
      out.push(r);
      continue;
    }
    const items = r.items.filter((m) => {
      const k = `${m.type}-${m.id}`;
      if (isDisliked(m.type, m.id)) return false;
      if (r.style !== 'TOP10' && (shown.has(k) || watched.has(titleKey(m.type, m.id)))) return false;
      return true;
    });
    items.forEach((m) => shown.add(`${m.type}-${m.id}`));
    if (items.length >= (r.style === 'TOP10' ? 3 : 4)) out.push({ ...r, items });
  }
  return out;
}


/** POSTER — обычный ряд постеров; TOP10 — крупные пронумерованные карточки; BANNER — широкие. */
export type RowStyle = 'POSTER' | 'TOP10' | 'BANNER' | 'MOOD';

/** Чем ряд ЯВЛЯЕТСЯ — для двух рядов, которые главный экран ставит по роли, а не по позиции. */
export type RowRole = 'PLAIN' | 'DAILY' | 'SEASONAL';

export interface FeedRow {
  key: string;
  title: string;
  items: MediaItem[];
  style: RowStyle;
  role: RowRole;
  /** Для ряда «Настроение»: из какого каталога жанры (на Главной — оба). */
  mood?: 'all' | 'movie' | 'tv';
}

const moodRow = (mood: 'all' | 'movie' | 'tv'): FeedRow => ({
  key: `MOOD:${mood}`,
  title: 'Настроение',
  items: [],
  style: 'MOOD',
  role: 'PLAIN',
  mood,
});

export interface TabFeed {
  billboards: MediaItem[];
  rows: FeedRow[];
}

/** Ряд отбрасывается целиком, если после фильтров в нём ничего не осталось. TOP10 обрезается до 10. */
/**
 * Слоганы для широких карточек («Сейчас в кино»): в списочных ответах TMDB их нет, они есть
 * только в подробностях тайтла (ответы помнятся — см. tmdb.ts). Берём первые десять.
 */
async function withTaglines(items: MediaItem[]): Promise<MediaItem[]> {
  const head = await Promise.all(
    items.slice(0, 10).map(async (it) => {
      try {
        const d = await TmdbApi.detailsLite(it.type, it.id); // нужен только слоган
        return { ...it, tagline: d.tagline?.trim() || null };
      } catch {
        return it;
      }
    }),
  );
  return [...head, ...items.slice(10)];
}

function row(
  title: string,
  items: MediaItem[],
  style: RowStyle = 'POSTER',
  role: RowRole = 'PLAIN',
): FeedRow | null {
  const list = curated(items);
  if (list.length === 0) return null;
  return {
    key: `${style}:${title}`,
    title,
    items: style === 'TOP10' ? list.slice(0, 10) : list,
    style,
    role,
  };
}

/*
  КАРУСЕЛЬ ВВЕРХУ ФИЛЬМОВ/СЕРИАЛОВ ГОТОВИТСЯ ВМЕСТЕ С ЛЕНТОЙ: лента не отдаётся экрану, пока у её
  карточек не прогреты кадры и логотипы (адрес, файл и разбор — см. logoLook). Иначе первая
  карточка открывалась с набранным названием, и через мгновение его подменял логотип другого
  размера — «логотип прыгает». Ждём не дольше трёх секунд: медленная сеть не держит ленту.
*/
async function warmHero(items: MediaItem[]): Promise<MediaItem[]> {
  const work = Promise.all(
    items.map(async (b) => {
      try {
        const u = await logoUrl(b.type, b.id);
        await Promise.all([
          u ? Image.prefetch(u).catch(() => false) : null,
          u ? primeLogoLook(u) : null,
          b.backdropUrl ? Image.prefetch(b.backdropUrl).catch(() => false) : null,
        ]);
      } catch {
        /* без логотипа — будет название текстом, сразу и без подмены */
      }
    }),
  );
  await Promise.race([work, new Promise((r) => setTimeout(r, 3000))]);
  return items;
}

function billboardPicks(items: MediaItem[]): MediaItem[] {
  return curated(items)
    .filter((i) => i.backdropUrl !== null && i.overview.trim() !== '')
    .slice(0, 6);
}

/**
 * Дотягивает для карточек героя то, чего нет в списочных ответах: слоган, продолжительность и
 * жанры.
 *
 * В списочных ответах TMDB слогана нет вовсе — он приходит только в подробностях тайтла. Раньше
 * вместо него на карточке стояло первое предложение синопсиса, и это было заметно: синопсис
 * пересказывает сюжет, а слоган — это фраза с афиши, ради которой карточка и существует.
 *
 * Запросов ровно столько, сколько карточек в герое (шесть), и они идут разом. Тайтл без слогана —
 * обычное дело, а не ошибка: тогда строка просто не показывается.
 */
async function withHeroDetails(items: MediaItem[]): Promise<MediaItem[]> {
  return Promise.all(
    items.map(async (item) => {
      try {
        const dto = await TmdbApi.detailsLite(item.type, item.id); // слоган, длительность, жанры
        return {
          ...item,
          tagline: dto.tagline?.trim() || null,
          // У сериала нет одной длительности — берём длительность серии, это ближайшее по смыслу.
          runtimeMinutes: dto.runtime ?? dto.episode_run_time?.[0] ?? null,
          genreNames: (dto.genres ?? []).map((g) => g.name),
        };
      } catch {
        return item;
      }
    }),
  );
}

/** Пустой массив вместо падения — один упавший ряд не должен ронять всю ленту. */
async function safe(p: Promise<MediaItem[]>): Promise<MediaItem[]> {
  try {
    return await p;
  } catch {
    return [];
  }
}

async function discoverMovies(params: Record<string, string>): Promise<MediaItem[]> {
  const page = await TmdbApi.discover('movie', params);
  return mainstream(mapItems(page.results, 'movie'));
}

async function genreMovies(genreId: number): Promise<MediaItem[]> {
  const page = await TmdbApi.discover('movie', { with_genres: String(genreId), 'vote_count.gte': '300' }, dayPage(genreId));
  return dayShuffle(mainstream(mapItems(page.results, 'movie')), genreId);
}

async function genreTv(genreId: number): Promise<MediaItem[]> {
  const page = await TmdbApi.discover('tv', { with_genres: String(genreId), 'vote_count.gte': '150' }, dayPage(genreId));
  return dayShuffle(mainstream(mapItems(page.results, 'tv')), genreId);
}

/** Ряд-повод: discover с его параметрами, страница — по дню года (как у Влада: день % 5 + 1). */
async function occasionItems(o: Occasion, page: number): Promise<MediaItem[]> {
  const res = await TmdbApi.discover(o.type, paramsOf(o), page);
  return dayShuffle(mainstream(mapItems(res.results, o.type)), page * 13 + o.title.length);
}

/*
  РАСКЛАДКА ЛЕНТ (октябрь, просьба Марка) — одна на Главной, Фильмах и Сериалах:
    сверху (плитки / карусель) → ТОП 10 → два-три ряда → «НАСТРОЕНИЕ» (жанровые плитки из APK) →
    «СЕЙЧАС В КИНО» (широкие карточки; у сериалов — «Сейчас в эфире») → остальные ряды.
  Состав рядов Главной — как у Влада (ряд по времени суток, повод дня, праздничные ряды в сезон).
  Кинофестов в ленте нет — они живут за плиткой «Кинофест».
*/
async function buildHomeFeed(): Promise<TabFeed> {
  const now = new Date();
  const live = liveRowSpec(now);
  const day = dayOfYear(now);
  const page = (day % 5) + 1;
  const trending = safe(TmdbApi.trending().then((p) => mapItems(p.results)));
  const nowPlaying = safe(TmdbApi.nowPlaying().then((p) => withTaglines(curated(mainstream(mapItems(p.results, 'movie'))))));
  // Персональное — параллельно с остальным; упало — лента просто без него.
  const personal = Promise.all([sagaRows().catch(() => []), tasteRows('all').catch(() => [])]);
  const common = Promise.all([
    safe(TmdbApi.topRatedMovies(dayPage(1)).then((p) => dayShuffle(mainstream(mapItems(p.results, 'movie')), 1))),
    safe(genreMovies(27)),
    safe(genreTv(10765)),
    safe(genreMovies(16)),
    safe(TmdbApi.popularTv(dayPage(2)).then((p) => dayShuffle(mainstream(mapItems(p.results, 'tv')), 2))),
  ]);
  const [top, cinema, [sagas, taste], [topMovies, horror, scifiTv, animation, popTv]] = await Promise.all([trending, nowPlaying, personal, common]);
  const tail = [
    row('Высокий рейтинг', topMovies),
    row('Ужасы', horror),
    row('Фантастика', scifiTv),
    row('Мультфильмы', animation),
    row('Популярные сериалы', popTv),
  ];

  if (isHalloween(now) || isNewYear(now)) {
    /*
      В праздник — ТОЛЬКО ДВА праздничных ряда (просьба Марка), сразу после топа; дальше обычная
      лента. Какие два — сдвигается по дню года, так что за сезон видны все.
    */
    const list = isHalloween(now) ? HALLOWEEN_ROWS : OCCASIONS.filter((o) => o.pinned && o.from === 1210);
    const two = [list[day % list.length], list[(day + 1) % list.length]];
    const holiday = await Promise.all(two.map((o) => safe(occasionItems(o, 1))));
    const rows = [
      row('Топ 10 за неделю', top, 'TOP10'),
      ...two.map((o, i) => row(o.title, holiday[i], 'POSTER', 'SEASONAL')),
      ...sagas,
      taste[0] ?? null,
      moodRow('all'),
      row('Сейчас в кино', cinema, 'BANNER'),
      taste[1] ?? null,
      ...tail,
    ].filter((r): r is FeedRow => r !== null);
    return { billboards: [], rows: diversify(rows) };
  }

  const occ = occasionToday(now);
  const [liveMovies, occItems] = await Promise.all([
    safe(discoverMovies(live.params).then((l) => dayShuffle(l, 5))),
    occ ? safe(occasionItems(occ, page)) : Promise.resolve([] as MediaItem[]),
  ]);
  /*
    Порядок: топ → персональное (саги, «потому что вам нравится») → ряд по времени суток →
    «Настроение» и «Сейчас в кино» → второй персональный ряд, повод дня → остальное.
  */
  const rows = [
    row('Топ 10 за неделю', top, 'TOP10'),
    ...sagas,
    taste[0] ?? null,
    row(live.title, liveMovies, 'POSTER', 'DAILY'),
    moodRow('all'),
    row('Сейчас в кино', cinema, 'BANNER'),
    taste[1] ?? null,
    occ ? row(occ.title, occItems, 'POSTER', 'SEASONAL') : null,
    ...tail,
  ].filter((r): r is FeedRow => r !== null);

  return { billboards: [], rows: diversify(rows) };
}

async function buildMoviesFeed(): Promise<TabFeed> {
  const [trend, popular, now, top, action, comedy, horror, scifi, romance, animation] =
    await Promise.all([
      safe(TmdbApi.trendingMovies().then((p) => mainstream(mapItems(p.results, 'movie')))),
      safe(TmdbApi.popularMovies().then((p) => mainstream(mapItems(p.results, 'movie')))),
      safe(TmdbApi.nowPlaying().then((p) => withTaglines(curated(mainstream(mapItems(p.results, 'movie')))))),
      safe(TmdbApi.topRatedMovies().then((p) => mainstream(mapItems(p.results, 'movie')))),
      safe(genreMovies(28)),
      safe(genreMovies(35)),
      safe(genreMovies(27)),
      safe(genreMovies(878)),
      safe(genreMovies(10749)),
      safe(genreMovies(16)),
    ]);

  const taste = await tasteRows('movie').catch(() => [] as FeedRow[]);
  const rows = [
    row('Топ 10 фильмов', trend, 'TOP10'),
    taste[0] ?? null,
    row('Популярное', popular),
    moodRow('movie'),
    row('Сейчас в кино', now, 'BANNER'),
    row('Боевики', action),
    row('Комедии', comedy),
    row('Ужасы', horror),
    row('Фантастика', scifi),
    row('Мелодрамы', romance),
    taste[1] ?? null,
    row('Высокий рейтинг', top),
    row('Мультфильмы', animation),
  ].filter((r): r is FeedRow => r !== null);

  return { billboards: await warmHero(await withHeroDetails(billboardPicks(trend))), rows: diversify(rows) };
}

async function buildTvFeed(): Promise<TabFeed> {
  const [trend, popular, top, onAir, drama, crime, comedy, scifi, action] = await Promise.all([
    safe(TmdbApi.trendingTv().then((p) => mainstream(mapItems(p.results, 'tv')))),
    safe(TmdbApi.popularTv().then((p) => mainstream(mapItems(p.results, 'tv')))),
    safe(TmdbApi.topRatedTv().then((p) => mainstream(mapItems(p.results, 'tv')))),
    safe(TmdbApi.onTheAir().then((p) => withTaglines(curated(mainstream(mapItems(p.results, 'tv')))))),
    safe(genreTv(18)),
    safe(genreTv(80)),
    safe(genreTv(35)),
    safe(genreTv(10765)),
    safe(genreTv(10759)),
  ]);

  const taste = await tasteRows('tv').catch(() => [] as FeedRow[]);
  const rows = [
    row('Топ 10 сериалов', trend, 'TOP10'),
    taste[0] ?? null,
    row('Популярные', popular),
    moodRow('tv'),
    row('Сейчас в эфире', onAir, 'BANNER'),
    row('Драмы', drama),
    row('Криминал', crime),
    row('Комедии', comedy),
    row('Фантастика', scifi),
    row('Боевики и приключения', action),
    taste[1] ?? null,
    row('Высокий рейтинг', top),
  ].filter((r): r is FeedRow => r !== null);

  return { billboards: await warmHero(await withHeroDetails(billboardPicks(trend))), rows: diversify(rows) };
}

/**
 * ЛЕНТА СОБИРАЕТСЯ ОДИН РАЗ ЗА ЗАПУСК.
 *
 * Каждая вкладка — это полтора десятка запросов к TMDB, и без этого они уходили заново при каждом
 * построении экрана: заставка греет ленту, а вкладка, открывшись, тут же начинала грузить её
 * второй раз и показывала крутилку поверх уже готовых данных. Здесь запоминается САМО ОБЕЩАНИЕ, а
 * не результат, поэтому два одновременных обращения (заставка и экран) сливаются в один поход в
 * сеть, а не идут парой.
 *
 * Неудача не запоминается: упавшая по сети лента должна собираться заново при следующей попытке, а
 * не оставаться пустой до перезапуска.
 */
const inFlight = new Map<string, Promise<TabFeed>>();

function once(key: string, build: () => Promise<TabFeed>): Promise<TabFeed> {
  const hit = inFlight.get(key);
  if (hit) return hit;
  const p = build().catch((e) => {
    inFlight.delete(key);
    throw e;
  });
  inFlight.set(key, p);
  return p;
}

export const homeFeed = () => once('home', buildHomeFeed);
export const moviesFeed = () => once('movies', buildMoviesFeed);
export const tvFeed = () => once('tv', buildTvFeed);
