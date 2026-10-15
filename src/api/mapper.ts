// Портировано из data/tmdb/TmdbMapper.kt (упрощённо, под MVP каталога).

import type { MediaDetails, MediaItem, MediaType } from '../types/media';
import { TmdbImages } from './tmdb';
import type { TmdbDetailsDto, TmdbItemDto } from './tmdbTypes';

/** DTO из /search/multi несёт media_type; DTO из /trending, /discover, /popular — нет, тип известен
 * заранее по эндпоинту, поэтому он передаётся явно как fallback. */
export function mapItem(dto: TmdbItemDto, fallbackType?: MediaType): MediaItem | null {
  const type = (dto.media_type === 'movie' || dto.media_type === 'tv' ? dto.media_type : fallbackType) as
    | MediaType
    | undefined;
  if (!type) return null; // например media_type === 'person' в мультипоиске

  const title = dto.title ?? dto.name ?? '';
  const originalTitle = dto.original_title ?? dto.original_name ?? title;
  const date = dto.release_date ?? dto.first_air_date ?? null;

  return {
    id: dto.id,
    type,
    title,
    originalTitle,
    overview: dto.overview ?? '',
    posterUrl: TmdbImages.poster(dto.poster_path),
    backdropUrl: TmdbImages.backdrop(dto.backdrop_path),
    year: date ? date.slice(0, 4) : null,
    rating: dto.vote_average ?? 0,
    releaseDate: date,
    originalLanguage: dto.original_language ?? null,
    genreIds: dto.genre_ids ?? [],
    voteCount: dto.vote_count ?? 0,
  };
}

export function mapItems(dtos: TmdbItemDto[], fallbackType?: MediaType): MediaItem[] {
  return dtos.map((d) => mapItem(d, fallbackType)).filter((x): x is MediaItem => x !== null);
}

export function mapDetails(dto: TmdbDetailsDto, type: MediaType): MediaDetails | null {
  const item = mapItem(dto, type);
  if (!item) return null;
  const dir = dto.credits?.crew?.find((c) => c.job === 'Director') ?? null;
  return {
    item,
    runtimeMinutes: dto.runtime ?? dto.episode_run_time?.[0] ?? null,
    genres: dto.genres ?? [],
    tagline: dto.tagline || null,
    director: dir
      ? { id: dir.id, name: dir.name, character: 'Режиссёр', photoUrl: TmdbImages.profile(dir.profile_path) }
      : null,
    creators: (dto.created_by ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      character: 'Создатель',
      photoUrl: TmdbImages.profile(c.profile_path),
    })),
    cast: (dto.credits?.cast ?? []).slice(0, 20).map((c) => ({
      id: c.id,
      name: c.name,
      character: c.character,
      photoUrl: TmdbImages.profile(c.profile_path),
    })),
    seasons: (dto.seasons ?? [])
      .filter((s) => s.season_number > 0)
      .map((s) => ({ number: s.season_number, name: s.name, episodeCount: s.episode_count })),
    status: dto.status ?? null,
    /**
     * Кадры берутся ШИРОКИМ размером (w780), а не original: их до двух десятков, они лежат в
     * прокручиваемом ряду, и оригиналы — это мегабайты трафика ради картинок высотой в сто точек.
     * Сортировка по оценке: TMDB отдаёт их вперемешку, а первым в ряду должен стоять лучший кадр.
     */
    /*
      СОВЕТСКОЕ КИНО: страна производства — СССР (у TMDB это код «SU»), а если база записала
      Россию или страну не указала — снято на русском не позже 1991 года.
    */
    soviet: (() => {
      const raw = dto as unknown as { production_countries?: { iso_3166_1?: string }[]; origin_country?: string[]; original_language?: string };
      const cc = [...(raw.production_countries ?? []).map((c) => c.iso_3166_1 ?? ''), ...(raw.origin_country ?? [])];
      const year = Number(item.year) || 9999;
      if (cc.includes('SU')) return true;
      return year <= 1991 && (cc.includes('RU') || (cc.length === 0 && raw.original_language === 'ru'));
    })(),
    studios: (() => {
      const raw = dto as unknown as { production_companies?: { name: string }[]; networks?: { name: string }[] };
      const names = [...(raw.networks ?? []), ...(raw.production_companies ?? [])].map((c) => c.name).filter(Boolean);
      return [...new Set(names)].slice(0, 2);
    })(),
    // Только кадры без надписей (язык не указан): картинки теперь приходят и с ru/en — ради
    // логотипа (см. tmdb.details), а кадры с текстом поверх в ряд «Кадры» не годятся.
    backdrops: [...(dto.images?.backdrops ?? [])]
      .filter((b) => !(b as { iso_639_1?: string | null }).iso_639_1)
      .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))
      .slice(0, 20)
      .map((b) => `https://image.tmdb.org/t/p/w780${b.file_path}`),
    numberOfEpisodes: dto.number_of_episodes ?? 0,
  };
}

