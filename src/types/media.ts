// Портировано из data/model/Media.kt (Android TV приложение) — только то, что нужно каталогу.

export type MediaType = 'movie' | 'tv';

/** Одна карточка (постер) — унифицированно для фильмов и сериалов. */
export interface MediaItem {
  id: number;
  type: MediaType;
  title: string;
  originalTitle: string;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  year: string | null;
  rating: number;
  releaseDate: string | null;
  originalLanguage: string | null;
  genreIds: number[];
  voteCount: number;
  /** Слоган, продолжительность и жанры есть только в ПОДРОБНОСТЯХ тайтла — в списках их нет.
   * Для карточек героя они дозапрашиваются отдельно, см. withHeroDetails в api/feed.ts. */
  tagline?: string | null;
  runtimeMinutes?: number | null;
  genreNames?: string[];
}

/** Один ряд на главном экране. */
export interface MediaRow {
  key: string;
  title: string;
  items: MediaItem[];
}

export interface GenreInfo {
  id: number;
  name: string;
}

export interface CastMember {
  id: number;
  name: string;
  character: string;
  photoUrl: string | null;
}

export interface SeasonInfo {
  number: number;
  name: string;
  episodeCount: number;
}

/** Развёрнутая карточка тайтла — экран "Детали". */
export interface MediaDetails {
  item: MediaItem;
  runtimeMinutes: number | null;
  genres: GenreInfo[];
  tagline: string | null;
  cast: CastMember[];
  /** Фильмы — режиссёр (crew, job === "Director"). */
  director: CastMember | null;
  /** Сериалы — создатели (created_by). У сериала режиссёра фильма нет, есть шоураннер. */
  creators: CastMember[];
  seasons: SeasonInfo[];
  status: string | null;
  numberOfEpisodes: number;
  /** Кадры из фильма (TMDB backdrops) — ряд «Кадры» внизу страницы. */
  backdrops: string[];
  /** Студии (у сериалов — ещё и каналы), по-английски, как в TMDB. */
  studios: string[];
  /** Советский фильм/сериал — для него есть бесплатные официальные копии у киностудий (SovietSources). */
  soviet: boolean;
}

const RU_MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

/** "15 марта 2026" из "YYYY-MM-DD" — null, если распарсить не удалось. */
export function formatRuDate(date: string | null | undefined): string | null {
  if (!date) return null;
  const parts = date.split('-');
  if (parts.length !== 3) return null;
  const day = parseInt(parts[2], 10);
  const monthIdx = parseInt(parts[1], 10) - 1;
  const month = RU_MONTHS[monthIdx];
  if (!month || Number.isNaN(day)) return null;
  return `${day} ${month} ${parts[0]}`;
}

export function isFutureDate(date: string | null | undefined): boolean {
  if (!date) return false;
  const target = new Date(date + 'T00:00:00');
  if (Number.isNaN(target.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return target.getTime() > today.getTime();
}
