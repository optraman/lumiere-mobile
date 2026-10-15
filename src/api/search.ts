import { TmdbApi } from './tmdb';
import { mapItems } from './mapper';
import type { MediaItem, MediaType } from '../types/media';
import { TmdbImages } from './tmdb';
import { swapLayout, probesFor, fuzzyPick } from './queryRepair';

export interface PersonHit {
  id: number;
  name: string;
  photoUrl: string | null;
  /** Русифицированный отдел: «Актёр», «Режиссёр». */
  role: string;
}

export interface GenreHit {
  id: number;
  name: string;
  type: MediaType;
}

export interface SearchResults {
  movies: MediaItem[];
  series: MediaItem[];
  people: PersonHit[];
  genres: GenreHit[];
}

/** TMDB отдаёт отдел по-английски даже при language=ru-RU. */
const RU_DEPT: Record<string, string> = {
  Acting: 'Актёр',
  Directing: 'Режиссёр',
  Writing: 'Сценарист',
  Production: 'Продюсер',
  Sound: 'Композитор',
  Camera: 'Оператор',
};

// Справочник жанров меняется раз в годы — берём по одному разу за запуск.
let genreCache: GenreHit[] | null = null;

async function allGenres(): Promise<GenreHit[]> {
  if (genreCache) return genreCache;
  const [mv, tv] = await Promise.all([
    TmdbApi.genres('movie').catch(() => ({ genres: [] })),
    TmdbApi.genres('tv').catch(() => ({ genres: [] })),
  ]);
  const list: GenreHit[] = [
    ...mv.genres.map((g) => ({ ...g, type: 'movie' as MediaType })),
    ...tv.genres.map((g) => ({ ...g, type: 'tv' as MediaType })),
  ];
  genreCache = list;
  return list;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').trim();
}

/**
 * Поиск сразу по нескольким видам: фильмы, сериалы, люди, жанры.
 *
 * Один запрос /search/multi уже возвращает и тайтлы, и людей — отдельные запросы на актёров не
 * нужны, TMDB и так ищет по ним. Разложение по категориям делается здесь, а не на экране: экран не
 * должен знать, что «person» — это отдел, а «tv» — сериал.
 *
 * Жанры ищутся ЛОКАЛЬНО по справочнику: у TMDB нет поиска по жанрам, а «ужасы» или «комедия» — это
 * ровно то, что человек может набрать, ожидая подборку, а не фильм с таким названием.
 *
 * Фильтры ленты (curated/mainstream) здесь НЕ применяются намеренно: если человек ищет что-то
 * редкое, он этого хочет, и лента не вправе прятать это от него. Это правило Влада, см. curate.ts.
 */
export async function searchAll(query: string): Promise<SearchResults> {
  const q = norm(query);

  const [multi, genres] = await Promise.all([
    TmdbApi.searchMulti(query),
    allGenres().catch(() => [] as GenreHit[]),
  ]);

  let raw = multi.results ?? [];

  /**
   * ПОИСК С ОПЕЧАТКАМИ — по близкому слову, а не точь-в-точь.
   *
   * Раньше починка включалась, только если TMDB вернул ПУСТОТУ. Но на опечатку TMDB почти всегда
   * что-нибудь да находит — случайные тайтлы с похожим кусочком, — и починка не включалась вовсе.
   * Теперь вопрос другой: есть ли среди ответа хоть что-то БЛИЗКОЕ к набранному (по расстоянию
   * правок, fuzzyPick)? Нет — значит, скорее всего опечатка, и параллельно идут пробы: другая
   * раскладка, начало запроса, отдельные слова, запрос без последней буквы. Всё найденное
   * просеивается по близости к ИСХОДНОМУ запросу, близкое встаёт первым, а прежний ответ — следом
   * (вдруг человек искал именно его).
   */
  const titleOf = (h: { title?: string; name?: string; original_title?: string; original_name?: string }) =>
    h.title ?? h.name ?? '';
  const origOf = (h: { original_title?: string; original_name?: string }) => h.original_title ?? h.original_name ?? '';
  const close = (list: typeof raw) => {
    const a = fuzzyPick(query, list, titleOf);
    const b = fuzzyPick(query, list, origOf);
    const seen = new Set(a.map((h) => `${h.media_type}-${h.id}`));
    return [...a, ...b.filter((h) => !seen.has(`${h.media_type}-${h.id}`))];
  };

  if (query.trim().length >= 3 && close(raw).length === 0) {
    const q = query.trim();
    const probes = [swapLayout(q), ...probesFor(q)];
    if (q.length >= 4 && q.length <= 6) probes.push(q.slice(0, -1));
    const uniq = [...new Set(probes.filter((x): x is string => !!x && x.toLowerCase() !== q.toLowerCase()))].slice(0, 5);
    const answers = await Promise.all(uniq.map((p) => TmdbApi.searchMulti(p).catch(() => null)));
    const swapped = swapLayout(q);
    // Раскладка — не опечатка: её ответ берётся целиком, без просеивания (там совсем другой текст).
    const swapHits = swapped ? answers[uniq.indexOf(swapped)]?.results ?? [] : [];
    const pool = answers.flatMap((r) => r?.results ?? []);
    const picked = close(pool);
    if (swapHits.length || picked.length) {
      const seen = new Set<string>();
      raw = [...swapHits, ...picked, ...raw].filter((h) => {
        const k = `${h.media_type}-${h.id}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
  }

  const movies = mapItems(raw.filter((r) => r.media_type === 'movie'), 'movie');
  const series = mapItems(raw.filter((r) => r.media_type === 'tv'), 'tv');

  const people: PersonHit[] = raw
    .filter((r) => r.media_type === 'person')
    .map((r) => {
      const p = r as unknown as {
        id: number;
        name?: string;
        profile_path?: string | null;
        known_for_department?: string;
      };
      return {
        id: p.id,
        name: p.name ?? '',
        photoUrl: TmdbImages.profile(p.profile_path),
        role: RU_DEPT[p.known_for_department ?? ''] ?? p.known_for_department ?? '',
      };
    })
    .filter((p) => p.name);

  // Совпадение по началу слова, а не по вхождению: «ужас» найдёт «Ужасы», но «ор» не вытащит
  // «История» и «Хоррор» разом. Плюс допуск на опечатку — «комелия» тоже должна находить комедию.
  const exact = genres.filter((g) => {
    const n = norm(g.name);
    return n.startsWith(q) || n.split(/\s+/).some((w) => w.startsWith(q));
  });
  const matched = exact.length > 0 ? exact : fuzzyPick(q, genres, (g) => g.name);
  // Один жанр может быть и у фильмов, и у сериалов под тем же именем — показываем по одному разу.
  const seen = new Set<string>();
  const uniqueGenres = matched.filter((g) => {
    const key = norm(g.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { movies, series, people, genres: uniqueGenres };
}

/** Подборка по жанру — открывается по нажатию на найденный жанр. */
export async function byGenre(genre: GenreHit): Promise<MediaItem[]> {
  const page = await TmdbApi.discover(genre.type, { with_genres: String(genre.id) });
  return mapItems(page.results, genre.type);
}
