// Сырые DTO из TMDB v3 — только поля, которые реально используются.

export interface TmdbItemDto {
  id: number;
  media_type?: 'movie' | 'tv' | 'person';
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  genre_ids?: number[];
  original_language?: string;
}

export interface TmdbPageDto {
  page: number;
  total_pages: number;
  total_results: number;
  results: TmdbItemDto[];
}

export interface TmdbGenreDto {
  id: number;
  name: string;
}

export interface TmdbCastDto {
  id: number;
  name: string;
  character: string;
  profile_path?: string | null;
}

export interface TmdbCrewDto {
  id: number;
  name: string;
  job: string;
  profile_path?: string | null;
}

export interface TmdbSeasonDto {
  season_number: number;
  name: string;
  episode_count: number;
}

export interface TmdbDetailsDto extends TmdbItemDto {
  runtime?: number;
  episode_run_time?: number[];
  tagline?: string;
  status?: string;
  number_of_episodes?: number;
  genres?: TmdbGenreDto[];
  credits?: {
    cast?: TmdbCastDto[];
    crew?: TmdbCrewDto[];
  };
  seasons?: TmdbSeasonDto[];
  /** Сериалы — создатели. У сериала нет «режиссёра фильма», эту роль занимает шоураннер. */
  created_by?: TmdbCastDto[];
  images?: TmdbImagesDto;
}

export interface TmdbImageDto {
  file_path: string;
  /** ISO 639-1, либо null — «в марке нет текста ни на каком языке». */
  iso_639_1: string | null;
  vote_average?: number;
}

export interface TmdbImagesDto {
  logos?: TmdbImageDto[];
  backdrops?: TmdbImageDto[];
}

export interface TmdbImageDto {
  file_path: string;
  iso_639_1: string | null;
  aspect_ratio?: number;
  width?: number;
  height?: number;
  vote_average?: number;
}

export interface TmdbImagesDto {
  logos?: TmdbImageDto[];
  backdrops?: TmdbImageDto[];
}

export interface TmdbPersonCreditDto extends TmdbItemDto {
  character?: string;
  job?: string;
  department?: string;
}

export interface TmdbPersonDto {
  id: number;
  name: string;
  biography?: string;
  profile_path?: string | null;
  known_for_department?: string;
  birthday?: string | null;
  place_of_birth?: string | null;
  combined_credits?: {
    cast?: TmdbPersonCreditDto[];
    crew?: TmdbPersonCreditDto[];
  };
}
